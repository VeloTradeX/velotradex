import { IStrategyParser, ParsedStrategy, StrategyRiskConfig, DiscordMessage } from './types';
import logger, { formatError } from '../../utils/logger';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import aiParserService from '../AIParserService';
import marketService from '../MarketService';
import { ImageDownloadCache } from '../../models';
import { assertSafeFetchUrl } from '../../utils/ssrfProtection';
import {
    extractEnglishText,
    isIgnorableMessage,
    isShortManagementText,
    escapeXML,
    areStrategiesEqual,
    buildDedupInfo
} from './RaizexbtTextMatchers';
import {
    LLMResult,
    SYSTEM_PROMPT,
    VISION_RULES,
    TEXT_RULES,
    OUTPUT_FORMAT,
    MARKET_PRICE_RULES,
    parseResponseContent
} from './RaizexbtAiPrompts';
import { convertToStrategies } from './RaizexbtStrategyConversion';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContextMessage {
    text: string;
    hasImage: boolean;
    ts: number;
}

export interface AIChartParserOptions {
    name?: string;
    debugLogName?: string;
    systemPrompt?: string;
    visionRules?: string;
    textRules?: string;
    outputFormat?: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export class RaizexbtParser implements IStrategyParser {
    name = 'RaizexbtParser';
    protected readonly systemPrompt: string;
    protected readonly visionRules: string;
    protected readonly textRules: string;
    protected readonly outputFormat: string;

    protected contextWindow: ContextMessage[] = [];
    protected readonly MAX_CONTEXT = 8;

    // Dedup
    protected processedMessageKeys: Map<string, number> = new Map();
    protected lastParsedStrategies: Map<string, ParsedStrategy[]> = new Map();
    protected readonly DEDUP_WINDOW_MS = 1000 * 60 * 10; // 10 min

    // TODO: Debug logging - 记录原始消息、提示词和 LLM 解析结果到 JSONL 文件，后续删除
    protected readonly DEBUG_LOG_DIR: string;

    // Image download retry
    protected readonly IMAGE_RETRY_DELAYS_MS = [1000, 3000, 6000];
    protected readonly IMAGE_MAX_RETRIES = this.IMAGE_RETRY_DELAYS_MS.length + 1;
    protected readonly LLM_MAX_RETRIES = 2;
    protected readonly LLM_RETRY_DELAY_MS = 3000;

    constructor(options: AIChartParserOptions = {}) {
        this.name = options.name || 'RaizexbtParser';
        this.systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
        this.visionRules = options.visionRules || VISION_RULES;
        this.textRules = options.textRules || TEXT_RULES;
        this.outputFormat = options.outputFormat || OUTPUT_FORMAT;
        this.DEBUG_LOG_DIR = path.resolve(process.cwd(), 'debug_logs', options.debugLogName || 'raizexbt');
    }

    protected get logPrefix(): string {
        return `${this.name}:`;
    }

    // ─── Interface ──────────────────────────────────────────────────────────

    public getRiskConfig(): StrategyRiskConfig {
        return {
            riskMode: 'fixed',
            riskValue: 10,
            defaultLeverage: '20',
            priceTolerance: 0.01, // 0.01R
            entryOrderMode: 'taker',
            tpDistribution: [0.5, 0.3, 0.2],
            tpOrderType: 'limit',
            tpOrderMode: 'maker',
            autoCloseOppositePosition: true,
            positionSizingMode: 'risk_based'
        };
    }

    public async parse(message: any, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
        const msg = message as DiscordMessage;
        const content = msg.content || '';
        const attachments: any[] = (message as any).attachments || [];

        // TODO: Debug audit trace - 记录完整的解析生命周期，后续删除
        const audit: Record<string, any> = {
            type: 'parse_trace',
            messageId: msg.id,
            isDryRun,
            rawMessage: { id: msg.id, content, attachments, ts: (message as any).ts },
            steps: [],
        };
        const addStep = (step: Record<string, any>) => audit.steps.push({ ...step, at: new Date().toISOString() });

        try {
            // 1. Message dedup (message.id first; fallback to channel+time bucket+content)
            if (!isDryRun && content) {
                const now = Date.now();
                const dedupInfo = buildDedupInfo(msg, attachments);
                const isShortMgmtText = isShortManagementText(content);
                const lastSeen = this.processedMessageKeys.get(dedupInfo.key);
                const hasPriorParsedState = !!msg.id && this.lastParsedStrategies.has(msg.id);

                if (lastSeen && (now - lastSeen < this.DEDUP_WINDOW_MS)) {
                    // For edited messages, skip message_id dedup so edit detection can compare revisions.
                    const shouldBypassDedupForRevision = dedupInfo.type === 'message_id' && hasPriorParsedState;
                    if ((!isShortMgmtText || dedupInfo.type === 'message_id') && !shouldBypassDedupForRevision) {
                        logger.info(`${this.logPrefix} Message dedup hit`, {
                            id: msg.id,
                            dedupType: dedupInfo.type,
                            isShortManagementText: isShortMgmtText,
                            hasPriorParsedState
                        });
                        addStep({
                            name: 'dedup',
                            status: 'hit',
                            dedupType: dedupInfo.type,
                            keyHash: dedupInfo.keyHash,
                            lastSeenAgo: now - lastSeen,
                            isShortManagementText: isShortMgmtText,
                            hasPriorParsedState
                        });
                        audit.outcome = 'dedup_hit';
                        return null;
                    }
                }

                this.processedMessageKeys.set(dedupInfo.key, now);
                this.cleanupMap(this.processedMessageKeys);
                addStep({
                    name: 'dedup',
                    status: 'pass',
                    dedupType: dedupInfo.type,
                    keyHash: dedupInfo.keyHash,
                    hasAttachmentFingerprint: dedupInfo.hasAttachmentFingerprint,
                    isShortManagementText: isShortMgmtText,
                    hasPriorParsedState
                });
            } else {
                addStep({ name: 'dedup', status: 'skipped', reason: isDryRun ? 'dry_run' : 'empty_content' });
            }

            // 2. Extract English text (strip Chinese translations)
            const englishText = extractEnglishText(content);
            audit.englishText = englishText;
            addStep({ name: 'extract_english', inputLength: content.length, outputLength: englishText.length });

            // 3. Pre-filter obvious non-trading messages (save API cost)
            const hasImageAttachment = attachments.some((a: any) => a.is_image);
            if (!hasImageAttachment && isIgnorableMessage(englishText)) {
                logger.debug(`${this.logPrefix} Pre-filtered ignorable message`, { text: englishText });
                addStep({ name: 'pre_filter', status: 'filtered', reason: 'isIgnorableMessage' });
                audit.outcome = 'pre_filtered';
                // Still add to context window for future reference
                if (!isDryRun) {
                    this.addToContext(englishText, false, (message as any).ts);
                }
                return null;
            }
            addStep({ name: 'pre_filter', status: 'pass' });

            // 4. Call LLM via AIParserService
            if (!aiParserService.isConfigured()) {
                logger.warn(`${this.logPrefix} AIParserService not configured, skipping`);
                addStep({ name: 'llm_client_check', status: 'not_configured' });
                audit.outcome = 'client_not_configured';
                return null;
            }

            let llmResult: LLMResult | null = null;
            const imageAttachment = attachments.find((a: any) => a.is_image);
            audit.hasImage = !!imageAttachment;

            if (imageAttachment) {
                // Vision path: download image and analyze with VLM
                const imageUrl = imageAttachment.proxy_url || imageAttachment.url;
                const downloadStart = Date.now();
                const imageBase64 = await this.downloadImageAsBase64(imageUrl);
                const downloadMs = Date.now() - downloadStart;

                if (imageBase64) {
                    addStep({
                        name: 'image_download',
                        status: 'success',
                        url: imageUrl.substring(0, 120),
                        sizeBytes: Math.round(imageBase64.length * 3 / 4),
                        durationMs: downloadMs,
                    });
                    llmResult = await this.analyzeWithVision(message, englishText, imageBase64, (message as any).ts, audit, addStep);
                } else {
                    addStep({
                        name: 'image_download',
                        status: 'failed',
                        url: imageUrl.substring(0, 120),
                        durationMs: downloadMs,
                        fallback: 'text_only',
                    });
                    // Image download failed, fall back to text-only
                    logger.warn(`${this.logPrefix} Image download failed, falling back to text-only analysis`);
                    llmResult = await this.analyzeTextOnly(message, englishText, (message as any).ts, audit, addStep);
                }
            } else {
                // Text-only path
                llmResult = await this.analyzeTextOnly(message, englishText, (message as any).ts, audit, addStep);
            }

            // 5. Update context window (after analysis, so context doesn't include current message)
            if (!isDryRun) {
                this.addToContext(englishText, !!imageAttachment, (message as any).ts);
            }

            if (!llmResult) {
                audit.outcome = audit.outcome || 'llm_returned_null';
                return null;
            }

            llmResult = this.normalizeLLMResultBeforeConvert(llmResult, message);
            if (!llmResult) {
                addStep({
                    name: 'normalize_llm_result',
                    status: 'empty',
                    reason: 'parser_specific_guard_returned_null',
                });
                audit.outcome = 'no_strategy';
                return null;
            }

            // 6. Convert LLM result to ParsedStrategy
            const strategies = convertToStrategies(llmResult, message, this.logPrefix);

            if (!strategies || strategies.length === 0) {
                addStep({
                    name: 'convert_to_strategies',
                    status: 'empty',
                    llmAction: llmResult.action,
                    reason: llmResult.action === 'ignore' ? 'action_is_ignore' : 'conversion_returned_null',
                    reasoning: llmResult.reasoning,
                });
                audit.outcome = 'no_strategy';
                audit.llmResult = llmResult;
                return null;
            }

            const cleanStrategies = strategies.map(s => { const { raw, ...rest } = s; return rest; });
            addStep({
                name: 'convert_to_strategies',
                status: 'success',
                count: strategies.length,
                strategies: cleanStrategies,
            });

            // 7. Edit detection (same as other parsers)
            if (!isDryRun) {
                const oldStrategies = this.lastParsedStrategies.get(msg.id);
                if (oldStrategies) {
                    if (areStrategiesEqual(oldStrategies, strategies)) {
                        logger.info(`${this.logPrefix} Unchanged edit`, { id: msg.id });
                        addStep({ name: 'edit_detection', status: 'unchanged_edit' });
                        audit.outcome = 'unchanged_edit';
                        return null;
                    }
                    addStep({ name: 'edit_detection', status: 'message_edited' });
                } else {
                    addStep({ name: 'edit_detection', status: 'new_message' });
                }
                this.lastParsedStrategies.set(msg.id, strategies);
            }

            audit.outcome = 'success';
            audit.finalStrategies = cleanStrategies;
            return strategies;

        } catch (error: any) {
            logger.error(`${this.logPrefix} parse() failed`, formatError(error), error.response?.data);
            addStep({
                name: 'error',
                error: error.message,
                stack: error.stack?.split('\n').slice(0, 5),
                responseData: error.response?.data,
            });
            audit.outcome = 'error';
            return null;
        } finally {
            // TODO: 无论成功还是失败都写入审计日志，后续删除
            this.writeDebugLog(audit);
        }
    }

    // ─── Context Management ─────────────────────────────────────────────────

    protected addToContext(text: string, hasImage: boolean, ts: number): void {
        this.contextWindow.push({ text, hasImage, ts: ts || Date.now() });
        if (this.contextWindow.length > this.MAX_CONTEXT) {
            this.contextWindow.shift();
        }
    }

    protected formatContextXML(): string {
        if (this.contextWindow.length === 0) return '<context>\n  <empty>No recent messages</empty>\n</context>';

        const messages = this.contextWindow.map(msg => {
            const escapedText = escapeXML(msg.text);
            return `  <message ts="${msg.ts}">\n    <text>${escapedText}</text>\n    <has_image>${msg.hasImage}</has_image>\n  </message>`;
        }).join('\n');

        return `<context>\n${messages}\n</context>`;
    }

    // ─── LLM Calls ─────────────────────────────────────────────────────────

    protected async analyzeWithVision(
        rawMessage: any, text: string, imageBase64: string, ts: number,
        audit: Record<string, any>, addStep: (step: Record<string, any>) => void
    ): Promise<LLMResult | null> {
        const positionsXml = await aiParserService.buildPositions(this.name);
        const marketPricesXml = await marketService.getCommonMarketPricesXml();
        const context = this.formatContextXML();
        const escapedText = escapeXML(text || '(no text, image only)');

        const userTextPrompt = `${positionsXml}\n\n${marketPricesXml}\n\n${context}\n\n<current_message ts="${ts}">\n  <text>${escapedText}</text>\n  <image>attached (see image below)</image>\n</current_message>\n\n${MARKET_PRICE_RULES}\n\n${this.visionRules}\n\n${this.outputFormat}`;

        const userContent: any[] = [
            { type: 'text', text: userTextPrompt },
            {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            }
        ];

        logger.info(`${this.logPrefix} Sending vision request to AIParserService`, { textLength: text.length });

        // TODO: 记录 LLM 请求和响应全过程，后续删除
        const llmStart = Date.now();
        let rawContent: string | null = null;
        let usage: any;
        let responseRaw: any;
        let successAttempt = 0;
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.LLM_MAX_RETRIES + 1; attempt++) {
            try {
                const aiResponse = await aiParserService.analyzeRaw({
                    systemPrompt: this.systemPrompt,
                    userContent: userContent,
                    originalMessage: rawMessage,
                    timeout: 60000
                });

                if (!aiResponse) throw new Error('AI analysis disabled or returned null');

                rawContent = aiResponse.content;
                usage = aiResponse.usage;
                responseRaw = aiResponse.raw;
                successAttempt = attempt;
                break;
            } catch (error: any) {
                lastError = error;
                logger.warn(`${this.logPrefix} Vision LLM call attempt ${attempt}/${this.LLM_MAX_RETRIES + 1} failed`, formatError(error, {
                    httpStatus: error.response?.status
                }));
                if (attempt <= this.LLM_MAX_RETRIES) {
                    await this.sleep(this.LLM_RETRY_DELAY_MS);
                }
            }
        }

        if (!rawContent) {
            const error = lastError || new Error('LLM call failed without detailed error');
            const llmMs = Date.now() - llmStart;
            addStep({
                name: 'llm_call',
                mode: 'vision',
                status: 'error',
                durationMs: llmMs,
                retries: this.LLM_MAX_RETRIES,
                error: error.message,
                httpStatus: error.response?.status,
                responseData: error.response?.data,
                prompt: { system: this.systemPrompt, userText: userTextPrompt.substring(0, 500) + '...(truncated)', hasImage: true },
            });
            audit.outcome = 'llm_call_error';
            throw error; // re-throw to be caught by parse()
        }

        const llmMs = Date.now() - llmStart;
        const result = parseResponseContent(rawContent, usage, this.logPrefix);

        addStep({
            name: 'llm_call',
            mode: 'vision',
            status: result ? 'success' : 'parse_failed',
            durationMs: llmMs,
            prompt: {
                system: this.systemPrompt,
                userText: userTextPrompt,
                hasImage: true,
                imageBase64Length: imageBase64.length,
            },
            llmRawResponse: rawContent,
            llmParsedResult: result,
            usage: usage || null,
            responseId: responseRaw?.id,
            attempt: successAttempt,
        });

        // 汇总 token usage 到审计顶层
        if (usage) {
            audit.tokenUsage = {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
            };
        }

        return result;
    }

    protected async analyzeTextOnly(
        rawMessage: any, text: string, ts: number,
        audit: Record<string, any>, addStep: (step: Record<string, any>) => void
    ): Promise<LLMResult | null> {
        const positionsXml = await aiParserService.buildPositions(this.name);
        const marketPricesXml = await marketService.getCommonMarketPricesXml();
        const context = this.formatContextXML();
        const escapedText = escapeXML(text);

        const userPrompt = `${positionsXml}\n\n${marketPricesXml}\n\n${context}\n\n<current_message ts="${ts}">\n  <text>${escapedText}</text>\n</current_message>\n\n${MARKET_PRICE_RULES}\n\n${this.textRules}\n\n${this.outputFormat}`;

        logger.info(`${this.logPrefix} Sending text-only request to AIParserService`, { textLength: text.length });

        // TODO: 记录 LLM 请求和响应全过程，后续删除
        const llmStart = Date.now();
        let rawContent: string | null = null;
        let usage: any;
        let responseRaw: any;
        let successAttempt = 0;
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.LLM_MAX_RETRIES + 1; attempt++) {
            try {
                const aiResponse = await aiParserService.analyzeRaw({
                    systemPrompt: this.systemPrompt,
                    userContent: userPrompt,
                    originalMessage: rawMessage,
                    timeout: 60000
                });

                if (!aiResponse) throw new Error('AI analysis disabled or returned null');

                rawContent = aiResponse.content;
                usage = aiResponse.usage;
                responseRaw = aiResponse.raw;
                successAttempt = attempt;
                break;
            } catch (error: any) {
                lastError = error;
                logger.warn(`${this.logPrefix} Text-only LLM call attempt ${attempt}/${this.LLM_MAX_RETRIES + 1} failed`, formatError(error, {
                    httpStatus: error.response?.status
                }));
                if (attempt <= this.LLM_MAX_RETRIES) {
                    await this.sleep(this.LLM_RETRY_DELAY_MS);
                }
            }
        }

        if (!rawContent) {
            const error = lastError || new Error('LLM call failed without detailed error');
            const llmMs = Date.now() - llmStart;
            addStep({
                name: 'llm_call',
                mode: 'text_only',
                status: 'error',
                durationMs: llmMs,
                retries: this.LLM_MAX_RETRIES,
                error: error.message,
                httpStatus: error.response?.status,
                responseData: error.response?.data,
                prompt: { system: this.systemPrompt, userText: userPrompt, hasImage: false },
            });
            audit.outcome = 'llm_call_error';
            throw error; // re-throw to be caught by parse()
        }

        const llmMs = Date.now() - llmStart;
        const result = parseResponseContent(rawContent, usage, this.logPrefix);

        addStep({
            name: 'llm_call',
            mode: 'text_only',
            status: result ? 'success' : 'parse_failed',
            durationMs: llmMs,
            prompt: {
                system: this.systemPrompt,
                userText: userPrompt,
                hasImage: false,
            },
            llmRawResponse: rawContent,
            llmParsedResult: result,
            usage: usage || null,
            responseId: responseRaw?.id,
            attempt: successAttempt,
        });

        // 汇总 token usage 到审计顶层
        if (usage) {
            audit.tokenUsage = {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
            };
        }

        return result;
    }

    // ─── Image Download ─────────────────────────────────────────────────────

    /**
     * Download image from URL and return as base64 string.
     * Supports proxy configuration and retries up to 3 times.
     */
    protected async downloadImageAsBase64(url: string): Promise<string | null> {
        const normalizedUrl = String(url || '').trim();
        if (!normalizedUrl) {
            return null;
        }

        // SSRF protection: reject unsafe/inner-network URLs before any request is made.
        try {
            await assertSafeFetchUrl(normalizedUrl);
        } catch (error: any) {
            logger.warn(`${this.logPrefix} Image URL rejected by SSRF protection`, formatError(error));
            return null;
        }

        const urlHash = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
        try {
            const cache = await ImageDownloadCache.findOne({ where: { urlHash } });
            if (cache?.imageBase64) {
                await cache.update({
                    hitCount: (cache.hitCount || 0) + 1,
                    lastAccessedAt: new Date()
                });
                logger.info(`${this.logPrefix} Image cache hit`, { urlHash });
                return cache.imageBase64;
            }
        } catch (error: any) {
            logger.warn(`${this.logPrefix} Failed to read image cache`, formatError(error));
        }

        const proxyUrl =
            process.env.ALL_PROXY ||
            process.env.HTTPS_PROXY ||
            process.env.HTTP_PROXY ||
            '';

        for (let attempt = 1; attempt <= this.IMAGE_MAX_RETRIES; attempt++) {
            try {
                logger.info(`${this.logPrefix} Downloading image (attempt ${attempt}/${this.IMAGE_MAX_RETRIES})`, { url: normalizedUrl.substring(0, 80) + '...' });

                const axiosConfig: any = {
                    url: normalizedUrl,
                    method: 'GET',
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    // Protect against unbounded downloads (10 MB hard limit).
                    maxContentLength: 10 * 1024 * 1024,
                    maxBodyLength: 10 * 1024 * 1024,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; CopyTrader/1.0)'
                    }
                };

                // Configure proxy if specified
                if (proxyUrl) {
                    const agent = new HttpsProxyAgent(proxyUrl);
                    axiosConfig.httpsAgent = agent;
                    axiosConfig.httpAgent = agent;
                }

                const response = await axios(axiosConfig);
                const buffer = Buffer.from(response.data);
                if (buffer.length > 10 * 1024 * 1024) {
                    throw new Error(`Image download exceeds maximum allowed size (${buffer.length} bytes)`);
                }
                const base64 = buffer.toString('base64');
                const mimeTypeHeader = response.headers?.['content-type'];
                const mimeType = typeof mimeTypeHeader === 'string' ? mimeTypeHeader.split(';')[0] : null;
                if (mimeType && !mimeType.startsWith('image/')) {
                    throw new Error(`Refused non-image response content-type: ${mimeType}`);
                }

                logger.info(`${this.logPrefix} Image downloaded successfully`, { sizeBytes: buffer.length });
                try {
                    await ImageDownloadCache.upsert({
                        url: normalizedUrl,
                        urlHash,
                        imageBase64: base64,
                        mimeType,
                        sizeBytes: buffer.length,
                        hitCount: 0,
                        lastAccessedAt: new Date()
                    });
                } catch (cacheError: any) {
                    logger.warn(`${this.logPrefix} Failed to write image cache`, formatError(cacheError));
                }
                return base64;

            } catch (error: any) {
                logger.warn(`${this.logPrefix} Image download attempt ${attempt} failed`, formatError(error));
                if (attempt < this.IMAGE_MAX_RETRIES) {
                    await this.sleep(this.IMAGE_RETRY_DELAYS_MS[attempt - 1]);
                }
            }
        }

        logger.error(`${this.logPrefix} All image download attempts failed`, { url: normalizedUrl.substring(0, 80) + '...' });
        return null;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    protected normalizeLLMResultBeforeConvert(result: LLMResult, _rawMessage: any): LLMResult | null {
        return result;
    }

    protected cleanupMap(map: Map<string, number>): void {
        if (map.size > 1000) {
            const now = Date.now();
            for (const [k, v] of map.entries()) {
                if (now - v > this.DEDUP_WINDOW_MS) map.delete(k);
            }
        }
    }

    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─── TODO: Debug JSONL Logging (后续删除) ────────────────────────────────

    /**
     * TODO: 将每次解析的原始消息、提示词和 LLM 返回结果写入 JSONL 文件，方便排查。
     * 文件按日期分片: debug_logs/raizexbt/2026-04-11.jsonl
     * 每行一条 JSON 记录，包含 timestamp、type 和对应的数据。
     * 后续功能稳定后删除此方法及相关调用。
     */
    protected writeDebugLog(data: Record<string, any>): void {
        try {
            if (!fs.existsSync(this.DEBUG_LOG_DIR)) {
                fs.mkdirSync(this.DEBUG_LOG_DIR, { recursive: true });
            }

            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
            const filePath = path.join(this.DEBUG_LOG_DIR, `${dateStr}.jsonl`);

            const record = {
                timestamp: now.toISOString(),
                ...data,
            };

            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err: any) {
            // Debug logging 不应影响主流程
            logger.warn(`${this.logPrefix} Failed to write debug log`, formatError(err));
        }
    }
}
