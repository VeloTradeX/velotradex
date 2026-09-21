import axios, { AxiosInstance } from 'axios';
import { AIConfig, Strategy, AILog } from '../models';
import logger, { formatError } from '../utils/logger';
import { Op } from 'sequelize';
import marketService from './MarketService';
import { AsyncLocalStorage } from 'async_hooks';
import { normalizeResult } from './AIParserResponseNormalizer';
import { buildRetryAnalyzeOptions } from './AIParserRetryOptions';
import { isAliyunCompatibleBaseUrl, normalizeProviderExtraPayload, parseExtraPayloadValue, resolveRequestTimeoutMs } from './AIParserProviderConfig';
import { buildPrompt, escapeXML } from './AIParserPromptBuilder';

export type AIAction = 'open' | 'close' | 'update' | 'cancel' | 'ignore';
export type AISide = 'buy' | 'sell';

export interface AIAnalysisResult {
    action: AIAction;
    symbol: string;
    side?: AISide;
    entryPrice?: number;
    targets?: number[];
    stopLoss?: number | 'breakeven' | null;
    leverage?: number;
    orderType?: 'market' | 'limit' | null;
    closePercentage?: number | null;
    closePrice?: number | null;
    riskMultiplier?: number | null;
    confidence?: number;
    reasoning?: string;
    original_message?: any;
}

export interface AIAnalysisOptions {
    systemPrompt?: string;
    userContent?: string | any[];
    originalMessage?: any;
    responseFormat?: any;
    extraPayload?: Record<string, any>;
    source?: string;
    strategyId?: number;
    routeIds?: number[];
    routeNames?: string[];
    timeout?: number;
    stripChinese?: boolean;
}

export interface AIRetrySourceLog {
    id?: number;
    strategyId?: number | null;
    routeIds?: string | number[] | null;
    routeNames?: string | string[] | null;
    systemPrompt?: string | null;
    originalMessage?: string | null;
    prompt?: string | null;
    imageBase64?: string | null;
}

type AnalyzeRawResult = { content: string; usage: any; raw: any; logId?: number };
type AIRouteContext = { routeIds?: number[]; routeNames?: string[] };

export { buildRetryAnalyzeOptions };

function buildRouteLogFields(options: Pick<AIAnalysisOptions, 'routeIds' | 'routeNames'> | AIRouteContext) {
    return {
        routeIds: options.routeIds?.length ? JSON.stringify(options.routeIds) : null,
        routeNames: options.routeNames?.length ? JSON.stringify(options.routeNames) : null,
    };
}

function serializeLogMessage(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

class AIParserService {
    private client: AxiosInstance | null = null;
    private config: AIConfig | null = null;
    private routeContextStorage = new AsyncLocalStorage<AIRouteContext>();

    constructor() {
        this.reloadConfig();
    }

    public async reloadConfig() {
        try {
            const config = await AIConfig.findOne({ where: { isActive: true } });
            if (config) {
                this.config = config;

                const baseURL = config.baseUrl || 'https://api.openai.com/v1';
                this.client = axios.create({
                    baseURL: baseURL,
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: resolveRequestTimeoutMs(undefined, config.requestTimeoutMs)
                });

                logger.info(`AIParserService loaded config: ${config.provider} (Text: ${config.textModel}, Vision: ${config.visionModel}) (BaseURL: ${baseURL})`);
            } else {
                this.config = null;
                this.client = null;
                logger.info('AIParserService disabled (no active config)');
            }
        } catch (error) {
            logger.error('Failed to load AI config', { error });
        }
    }

    public async analyze(
        message: any,
        currentPrice: number,
        source: string,
        strategyId?: number,
        routeContext?: AIRouteContext
    ): Promise<AIAnalysisResult | null> {
        if (!this.config || !this.client) {
            return null;
        }

        return await this.runAnalysisInternal(message, currentPrice, source, strategyId, routeContext);
    }

    public async runWithRouteContext<T>(routeContext: AIRouteContext, fn: () => Promise<T>): Promise<T> {
        return await this.routeContextStorage.run(routeContext, fn);
    }

    public getCurrentRouteContext(): AIRouteContext {
        return this.routeContextStorage.getStore() || {};
    }

    public async analyzeRaw(options: AIAnalysisOptions): Promise<AnalyzeRawResult | null> {
        if (!this.client || !this.config) return null;

        const startTime = Date.now();
        const hasVision = Array.isArray(options.userContent) && options.userContent.some((item: any) => item.type === 'image_url');
        const model = hasVision ? this.config.visionModel : this.config.textModel;
        let finalResponseContent = '';
        let promptToSave = '';
        let imageBase64ToSave: string | null = null;
        let processedSystemPrompt = options.systemPrompt;

        try {
            const messages: any[] = [];
            let processedUserContent = options.userContent;

            const shouldStripChinese = options.stripChinese !== undefined ? options.stripChinese : this.config.stripChinese;
            if (shouldStripChinese) {
                if (processedSystemPrompt) {
                    processedSystemPrompt = processedSystemPrompt.replace(/[\u4e00-\u9fa5]/g, '');
                }
                if (typeof processedUserContent === 'string') {
                    processedUserContent = processedUserContent.replace(/[\u4e00-\u9fa5]/g, '');
                } else if (Array.isArray(processedUserContent)) {
                    processedUserContent = processedUserContent.map((item: any) => {
                        if (item.type === 'text' && typeof item.text === 'string') {
                            return { ...item, text: item.text.replace(/[\u4e00-\u9fa5]/g, '') };
                        }
                        return item;
                    });
                }
            }

            if (processedSystemPrompt) {
                messages.push({ role: 'system', content: processedSystemPrompt });
            }
            if (processedUserContent) {
                messages.push({ role: 'user', content: processedUserContent });
            }

            if (typeof processedUserContent === 'string') {
                promptToSave = processedUserContent;
            } else if (Array.isArray(processedUserContent)) {
                const promptArray = processedUserContent.map((item: any) => {
                    if (item.type === 'image_url') {
                        imageBase64ToSave = item.image_url?.url || null;
                        return { type: 'image_url', image_url: { url: '[IMAGE_DATA]' } };
                    }
                    return item;
                });
                promptToSave = JSON.stringify(promptArray);
            }

            const providerExtraPayload = normalizeProviderExtraPayload(
                {
                    ...parseExtraPayloadValue(this.config?.extraPayload),
                    ...(options.extraPayload || {})
                },
                this.config?.baseUrl
            );
            const payload: any = {
                model,
                messages,
                temperature: 0.3,
                ...providerExtraPayload
            };

            // P0: 未显式配置 max_tokens / max_completion_tokens 时兜底设置，
            // 防止 LLM 在 strict json_schema 输出较长时被默认 token 上限截断
            // （截断的 JSON 无法被解析，表现为解析器持续返回 null）。
            if (payload.max_tokens === undefined && payload.max_completion_tokens === undefined) {
                payload.max_tokens = 2048;
            }

            if (options.responseFormat) {
                payload.response_format = options.responseFormat;
            }

            const response = await this.client.post('/chat/completions', payload, {
                timeout: resolveRequestTimeoutMs(options.timeout, this.config?.requestTimeoutMs)
            });

            const choice = response.data.choices?.[0];
            finalResponseContent = choice?.message?.content;

            if (!finalResponseContent) throw new Error('Empty response from AI (analyzeRaw)');

            const duration = Date.now() - startTime;
            const usage = response.data.usage;

            // Log usage
            const logRecord = await AILog.create({
                strategyId: options.strategyId || null,
                ...this.resolveRouteLogFields(options),
                model,
                originalMessage: serializeLogMessage(options.originalMessage) || serializeLogMessage(options.userContent),
                systemPrompt: processedSystemPrompt || null,
                prompt: promptToSave,
                response: finalResponseContent,
                promptTokens: usage?.prompt_tokens || 0,
                completionTokens: usage?.completion_tokens || 0,
                totalTokens: usage?.total_tokens || 0,
                durationMs: duration,
                status: 'success',
                imageBase64: imageBase64ToSave
            });

            return {
                content: finalResponseContent,
                usage,
                raw: response.data,
                logId: logRecord.id,
            };

        } catch (error: any) {
            const duration = Date.now() - startTime;
            const errorMsg = error.response?.data?.error?.message || error.message;
            logger.error('AI Analysis (Raw) failed', { error: errorMsg, status: error.response?.status });

            // Log failure
            await AILog.create({
                strategyId: options.strategyId || null,
                ...this.resolveRouteLogFields(options),
                model: model || 'unknown',
                originalMessage: serializeLogMessage(options.originalMessage) || serializeLogMessage(options.userContent),
                systemPrompt: processedSystemPrompt || null,
                prompt: promptToSave || 'Error building prompt',
                response: null,
                durationMs: duration,
                status: 'error',
                error: errorMsg,
                imageBase64: imageBase64ToSave
            });

            throw error; // re-throw for specific parser to handle failure log
        }
    }

    private async runAnalysisInternal(
        message: any,
        currentPrice: number,
        source: string,
        strategyId?: number,
        routeContext?: AIRouteContext
    ): Promise<AIAnalysisResult | null> {
        if (!this.client || !this.config) return null;

        const startTime = Date.now();
        let prompt = '';
        const systemPrompt = [
            "You are an expert crypto trading signal parser.",
            "Output ONLY valid JSON. No markdown, no code block.",
            "Action enum must be one of: open, close, update, cancel, ignore.",
            "If action=open, side must be buy or sell.",
            "Symbol must be normalized as BASE_USDT, e.g. BTC_USDT.",
            "If required fields are missing or ambiguous, return action=ignore with reasoning."
        ].join(' ');

        try {
            const contextXml = await this.buildContext(source, this.config.contextMessageCount, strategyId);
            const positionsXml = await this.buildPositions(source);
            const marketPricesXml = await marketService.getCommonMarketPricesXml();
            prompt = buildPrompt({
                message,
                currentPrice,
                contextXml,
                positionsXml,
                marketPricesXml,
                promptTemplate: this.config.promptTemplate,
                stripChinese: this.config.stripChinese,
            });

            logger.info('Sending request to AI...', { model: this.config.textModel });

            const payload = {
                model: this.config.textModel,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0.3,
                ...(isAliyunCompatibleBaseUrl(this.config?.baseUrl) ? { enable_thinking: false } : {})
            };

            const response = await this.client.post('/chat/completions', payload);

            const choice = response.data.choices?.[0];
            const content = choice?.message?.content;

            if (!content) throw new Error('Empty response from AI');

            const rawResult = JSON.parse(content);
            const result = normalizeResult(rawResult);
            if (!result) {
                throw new Error('AI response JSON invalid for trading schema');
            }
            result.original_message = message;

            const duration = Date.now() - startTime;
            const usage = response.data.usage;

            // Log usage
            await AILog.create({
                strategyId: strategyId || null,
                ...this.resolveRouteLogFields(routeContext || {}),
                model: this.config.textModel,
                originalMessage: typeof message === 'string' ? message : JSON.stringify(message),
                systemPrompt,
                prompt: prompt,
                response: content,
                promptTokens: usage?.prompt_tokens || 0,
                completionTokens: usage?.completion_tokens || 0,
                totalTokens: usage?.total_tokens || 0,
                durationMs: duration,
                status: 'success'
            });

            logger.info('AI Analysis Result', { result });
            return result;

        } catch (error: any) {
            const duration = Date.now() - startTime;
            const errorMsg = error.response?.data?.error?.message || error.message;
            logger.error('AI Analysis failed', { error: errorMsg });

            // Log failure
            await AILog.create({
                strategyId: strategyId || null,
                ...this.resolveRouteLogFields(routeContext || {}),
                model: this.config?.textModel || 'unknown',
                originalMessage: typeof message === 'string' ? message : JSON.stringify(message),
                systemPrompt,
                prompt: prompt || 'Error building prompt',
                response: null,
                durationMs: duration,
                status: 'error',
                error: errorMsg
            });

            return null;
        }
    }

    private resolveRouteLogFields(routeContext: AIRouteContext): { routeIds: string | null; routeNames: string | null } {
        const ambientContext = this.routeContextStorage.getStore() || {};
        return buildRouteLogFields({
            routeIds: routeContext.routeIds?.length ? routeContext.routeIds : ambientContext.routeIds,
            routeNames: routeContext.routeNames?.length ? routeContext.routeNames : ambientContext.routeNames,
        });
    }

    public async getModels(config?: { apiKey: string, baseUrl?: string, requestTimeoutMs?: number }): Promise<string[]> {
        let client = this.client;

        // If config provided, create a temporary client
        if (config && config.apiKey) {
            const baseURL = config.baseUrl || 'https://api.openai.com/v1';
            client = axios.create({
                baseURL: baseURL,
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: resolveRequestTimeoutMs(config.requestTimeoutMs, this.config?.requestTimeoutMs)
            });
        }

        if (!client) return [];

        try {
            const response = await client.get('/models');
            return response.data.data.map((m: any) => m.id);
        } catch (e: any) {
            logger.warn('Failed to fetch models list', formatError(e));
            return [];
        }
    }

    public async testConfig(config: any): Promise<{ success: boolean, message: string }> {
        try {
            const baseURL = config.baseUrl || 'https://api.openai.com/v1';
            const client = axios.create({
                baseURL: baseURL,
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: resolveRequestTimeoutMs(config.requestTimeoutMs, this.config?.requestTimeoutMs)
            });

            const response = await client.post('/chat/completions', {
                model: config.textModel,
                messages: [{ role: 'user', content: '你好' }],
                temperature: 0.3,
                ...normalizeProviderExtraPayload(parseExtraPayloadValue(config.extraPayload), config.baseUrl)
            });

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content || !String(content).trim()) {
                return { success: false, message: '模型调用成功但未返回内容' };
            }

            return { success: true, message: String(content).trim() };
        } catch (e: any) {
            const msg = e.response?.data?.error?.message || e.message;
            return { success: false, message: msg };
        }
    }

    private async buildContext(source: string, limit: number, excludeStrategyId?: number): Promise<string> {
        const where: any = { source };
        if (excludeStrategyId) {
            where.id = { [Op.ne]: excludeStrategyId };
        }
        // AI 上下文只使用实盘策略（回测子进程内策略未打标，行为不变）
        where.backtestRunId = { [Op.is]: null };
        const recentStrategies = await Strategy.findAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: limit
        });

        if (recentStrategies.length === 0) return "<context>\n  <empty>No recent context.</empty>\n</context>";

        const messages = recentStrategies.reverse().map((s: Strategy) => {
            const time = new Date(s.createdAt).toISOString();
            let content = s.rawMessage;
            try {
                const parsed = JSON.parse(s.rawMessage);
                if (parsed.content) content = parsed.content;
            } catch (e) {
                logger.debug('[AIParserService] Non-critical error in image hydration', formatError(e));
            }

            return `  <message ts="${time}">\n    <text>${escapeXML(content)}</text>\n  </message>`;
        }).join('\n');

        return `<context>\n${messages}\n</context>`;
    }

    public async buildPositions(source: string): Promise<string> {
        try {
            const { StrategyPosition } = require('../models');
            const positions = await StrategyPosition.findAll({
                where: { source, status: ['OPEN', 'PARTIAL'] }
            });

            if (!positions || positions.length === 0) {
                return "<positions>\n  <empty>No active positions</empty>\n</positions>";
            }

            const pLines = positions.map((p: any) =>
                `  <position symbol="${p.symbol}" side="${p.side}" remainingSize="${p.remainingSize}" status="${p.status}" />`
            ).join('\n');

            return `<positions>\n${pLines}\n</positions>`;
        } catch (e) {
            return "<positions>\n  <error>Failed to load positions</error>\n</positions>";
        }
    }

    public getMode(): string {
        return this.config?.mode || 'disabled';
    }

    public isConfigured(): boolean {
        return !!(this.config && this.client);
    }

    public async retryLogAnalysis(log: AIRetrySourceLog): Promise<AnalyzeRawResult | null> {
        const options = buildRetryAnalyzeOptions(log);
        return await this.analyzeRaw(options);
    }
}

export default new AIParserService();
