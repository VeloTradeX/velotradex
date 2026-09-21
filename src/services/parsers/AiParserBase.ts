/**
 * AiParserBase — 通用「文本优先、图片兜底」AI/视觉信号解析基类。
 *
 * 使用模板方法组织解析流程：默认先走子类最快的纯文本解析；仅当文本解析不出信号、
 * 且消息带图片时，才降级到视觉大模型识别，并经过子类自定义的守卫钩子校验后才放行。
 *
 * 子类需实现：
 * - rejectReason(content)     整条消息前置拒绝（如回复/管理类），返回原因或 null
 * - tryParseText()            文本优先解析（确定性、快），命中即不再走图片
 * - buildVisionUserContent()  构造传给视觉模型的 user content（含图片 base64）
 * - validateAndConvertVision() 视觉结果校验(G1..Gn) + 转成 ParsedStrategy
 * - getRiskConfig()           风控配置
 *
 * 基类已内置：图片安全下载(SSRF+缓存+重试)、图片幂等去重、编辑检测。
 */
import { IStrategyParser, ParsedStrategy, StrategyRiskConfig } from './types';
import logger, { formatError } from '../../utils/logger';
import aiParserService from '../AIParserService';
import { downloadImageAsBase64 } from '../imageDownload';

export interface VisionLLMResponse {
    content: string | null;
    usage?: any;
    raw?: any;
}

export abstract class AiParserBase implements IStrategyParser {
    name = 'AiParserBase';

    protected processedImageKeys: Map<string, number> = new Map();
    protected lastParsedStrategies: Map<string, ParsedStrategy[]> = new Map();
    protected readonly DEDUP_WINDOW_MS = 1000 * 60 * 10; // 10 min
    protected readonly LLM_MAX_RETRIES = 2;
    protected readonly LLM_RETRY_DELAY_MS = 3000;

    protected abstract get logPrefix(): string;
    protected abstract get systemPrompt(): string;
    protected abstract rejectReason(content: string): string | null;
    protected abstract tryParseText(message: any, isDryRun: boolean): Promise<ParsedStrategy[] | null>;
    protected abstract buildVisionUserContent(message: any, text: string, imageBase64: string, ts: any): Promise<any[]>;
    protected abstract validateAndConvertVision(res: VisionLLMResponse, message: any): Promise<ParsedStrategy[] | null>;
    public abstract getRiskConfig(): StrategyRiskConfig;

    public async parse(message: any, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
        const content = String(message?.content || '');

        try {
            // 1. 整条消息前置拒绝（回复/管理类 → 文本图均不处理）。
            const reject = this.rejectReason(content);
            if (reject) {
                logger.info(`${this.logPrefix} ${reject}`, { id: message?.id });
                return null;
            }

            // 2. 文本优先：子类确定性解析，命中即返回（不再走图片，避免一条消息开双单）。
            const textStrategies = await this.tryParseText(message, isDryRun);
            if (textStrategies && textStrategies.length) {
                return this.finalize(message, textStrategies, isDryRun);
            }

            // 3. 图片兜底：无文本结果、且带图片、且 AI(Vision) 已配置。
            const imageAttachment = this.findImageAttachment(message);
            if (!imageAttachment) {
                return null;
            }
            if (!aiParserService.isConfigured()) {
                logger.warn(`${this.logPrefix} AIParserService not configured, skipping image parsing`, { id: message?.id });
                return null;
            }

            // 4. 图片源幂等去重，防同一图重复投递/编辑导致多单。
            if (!isDryRun) {
                if (this.isDuplicateImage(imageAttachment)) {
                    logger.info(`${this.logPrefix} Duplicate image ignored`, { id: message?.id });
                    return null;
                }
                this.markImageSeen(imageAttachment);
            }

            // 5. 安全下载图片。
            const imageUrl = imageAttachment.proxy_url || imageAttachment.url;
            const imageBase64 = await downloadImageAsBase64(imageUrl, this.logPrefix);
            if (!imageBase64) {
                logger.warn(`${this.logPrefix} Image download failed, skipping image parsing`, { id: message?.id });
                return null;
            }

            // 6. 视觉识别。
            const englishText = this.extractEnglish(content);
            const userContent = await this.buildVisionUserContent(message, englishText, imageBase64, (message as any).ts);
            const res = await this.analyzeVisionWithRetry(message, userContent);
            if (!res || !res.content) {
                logger.warn(`${this.logPrefix} Vision LLM returned no usable result`, { id: message?.id });
                return null;
            }

            // 7. 子类校验(G1..Gn) + 转策略。
            const strategies = await this.validateAndConvertVision(res, message);
            if (!strategies || strategies.length === 0) {
                return null;
            }

            return this.finalize(message, strategies, isDryRun);
        } catch (error: any) {
            logger.error(`${this.logPrefix} parse() failed`, formatError(error));
            return null;
        }
    }

    protected findImageAttachment(message: any): any | null {
        const atts: any[] = message?.attachments || [];
        return atts.find(a => a && a.is_image) || null;
    }

    protected extractEnglish(content: string): string {
        return String(content || '').replace(/[\u4e00-\u9fa5]/g, '');
    }

    protected isDuplicateImage(imageAttachment: any): boolean {
        const key = this.imageFingerprint(imageAttachment);
        const last = this.processedImageKeys.get(key);
        return !!last && (Date.now() - last) < this.DEDUP_WINDOW_MS;
    }

    protected markImageSeen(imageAttachment: any): void {
        this.processedImageKeys.set(this.imageFingerprint(imageAttachment), Date.now());
        this.cleanupImageKeys();
    }

    protected imageFingerprint(imageAttachment: any): string {
        if (imageAttachment?.id) return `id:${imageAttachment.id}`;
        return `url:${imageAttachment?.url || imageAttachment?.proxy_url || ''}`;
    }

    protected cleanupImageKeys(): void {
        if (this.processedImageKeys.size > 1000) {
            const now = Date.now();
            for (const [k, v] of this.processedImageKeys) {
                if (now - v > this.DEDUP_WINDOW_MS) this.processedImageKeys.delete(k);
            }
        }
    }

    protected async analyzeVisionWithRetry(rawMessage: any, userContent: any[]): Promise<VisionLLMResponse | null> {
        let lastError: any = null;
        for (let attempt = 1; attempt <= this.LLM_MAX_RETRIES + 1; attempt++) {
            try {
                const aiResponse = await aiParserService.analyzeRaw({
                    systemPrompt: this.systemPrompt,
                    userContent,
                    originalMessage: rawMessage,
                    timeout: 60000,
                });
                if (!aiResponse) throw new Error('AI analysis disabled or returned null');
                return { content: aiResponse.content, usage: aiResponse.usage, raw: aiResponse.raw };
            } catch (error: any) {
                lastError = error;
                logger.warn(`${this.logPrefix} Vision LLM call attempt ${attempt}/${this.LLM_MAX_RETRIES + 1} failed`, formatError(error, {
                    httpStatus: error.response?.status,
                }));
                if (attempt <= this.LLM_MAX_RETRIES) {
                    await this.sleep(this.LLM_RETRY_DELAY_MS);
                }
            }
        }
        logger.error(`${this.logPrefix} All vision LLM attempts failed`, formatError(lastError));
        return null;
    }

    protected finalize(message: any, strategies: ParsedStrategy[], isDryRun: boolean): ParsedStrategy[] | null {
        if (isDryRun) return strategies;

        const old = this.lastParsedStrategies.get(message?.id);
        if (old) {
            if (this.areStrategiesEqual(old, strategies)) {
                logger.info(`${this.logPrefix} Unchanged edit`, { id: message?.id });
                return null;
            }
            logger.info(`${this.logPrefix} Message edited, replacing strategies`, { id: message?.id });
        }
        this.lastParsedStrategies.set(message?.id, strategies);
        return strategies;
    }

    protected areStrategiesEqual(a: ParsedStrategy[] | null, b: ParsedStrategy[] | null): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        const clean = (s: ParsedStrategy) => {
            const { raw, ...rest } = s;
            return rest;
        };
        return JSON.stringify(a.map(clean)) === JSON.stringify(b.map(clean));
    }

    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}