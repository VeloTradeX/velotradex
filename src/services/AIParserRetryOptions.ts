import type { AIAnalysisOptions, AIRetrySourceLog } from './AIParserService';

function tryParseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function isChatContentArray(value: unknown): value is any[] {
    return Array.isArray(value) && value.every((item) => item && typeof item === 'object' && typeof item.type === 'string');
}

function parseStoredNumberArray(value: string | number[] | null | undefined): number[] | undefined {
    if (Array.isArray(value)) {
        return value.filter((item) => Number.isFinite(item));
    }
    if (!value) return undefined;

    const parsed = tryParseJson(value);
    if (!Array.isArray(parsed)) return undefined;

    const numbers = parsed
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
    return numbers.length ? numbers : undefined;
}

function parseStoredStringArray(value: string | string[] | null | undefined): string[] | undefined {
    if (Array.isArray(value)) {
        const strings = value.map((item) => String(item).trim()).filter(Boolean);
        return strings.length ? strings : undefined;
    }
    if (!value) return undefined;

    const parsed = tryParseJson(value);
    if (Array.isArray(parsed)) {
        const strings = parsed.map((item) => String(item).trim()).filter(Boolean);
        return strings.length ? strings : undefined;
    }

    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
}

function hydrateImagePlaceholders(content: any[], imageBase64?: string | null): any[] {
    return content.map((item) => {
        if (item?.type !== 'image_url') return item;
        const currentUrl = item.image_url?.url;
        if (currentUrl && currentUrl !== '[IMAGE_DATA]') {
            return item;
        }
        if (!imageBase64) {
            throw new Error('Missing image payload for retry');
        }
        return {
            ...item,
            image_url: {
                ...item.image_url,
                url: imageBase64,
            },
        };
    });
}

export function buildRetryAnalyzeOptions(log: AIRetrySourceLog): AIAnalysisOptions {
    const parsedOriginal = typeof log.originalMessage === 'string' ? tryParseJson(log.originalMessage) : null;
    const routeIds = parseStoredNumberArray(log.routeIds);
    const routeNames = parseStoredStringArray(log.routeNames);
    const routeOptions = {
        ...(routeIds ? { routeIds } : {}),
        ...(routeNames ? { routeNames } : {}),
    };
    if (isChatContentArray(parsedOriginal)) {
        return {
            systemPrompt: log.systemPrompt || undefined,
            userContent: hydrateImagePlaceholders(parsedOriginal, log.imageBase64),
            strategyId: log.strategyId || undefined,
            ...routeOptions,
            timeout: 60000,
        };
    }

    const parsedPrompt = typeof log.prompt === 'string' ? tryParseJson(log.prompt) : null;
    if (isChatContentArray(parsedPrompt)) {
        return {
            systemPrompt: log.systemPrompt || undefined,
            userContent: hydrateImagePlaceholders(parsedPrompt, log.imageBase64),
            strategyId: log.strategyId || undefined,
            ...routeOptions,
            timeout: 60000,
        };
    }

    if (typeof log.prompt === 'string' && log.prompt.trim()) {
        return {
            systemPrompt: log.systemPrompt || undefined,
            userContent: log.prompt,
            strategyId: log.strategyId || undefined,
            ...routeOptions,
            timeout: 60000,
        };
    }

    if (typeof log.originalMessage === 'string' && log.originalMessage.trim()) {
        return {
            systemPrompt: log.systemPrompt || undefined,
            userContent: log.originalMessage,
            strategyId: log.strategyId || undefined,
            ...routeOptions,
            timeout: 60000,
        };
    }

    throw new Error('No retryable AI input found in log');
}
