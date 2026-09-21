import * as crypto from 'crypto';
import { DiscordMessage, ParsedStrategy } from './types';

// ─── Chinese Stripping ──────────────────────────────────────────────────

/**
 * Strip Chinese translations from message content.
 * Messages typically have format: "English text\nChinese translation\n--------------"
 * Also handles reply quote Chinese translations.
 */
export function extractEnglishText(content: string): string {
    if (!content) return '';

    // Split by the separator used in translated messages
    const parts = content.split('--------------');
    let text = parts[0].trim(); // Take only the part before separator

    // Remove lines that are purely Chinese characters (with optional punctuation)
    const lines = text.split('\n');
    const englishLines = lines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true; // Keep empty lines for structure

        // Remove lines that are purely Chinese (> 50% Chinese chars)
        const chineseChars = (trimmed.match(/[\u4e00-\u9fa5]/g) || []).length;
        const totalChars = trimmed.replace(/\s/g, '').length;
        if (totalChars > 0 && chineseChars / totalChars > 0.5) {
            return false;
        }
        return true;
    });

    text = englishLines.join('\n').trim();

    // Clean up reply format: "> **回复：xxx**" -> keep the reference part
    text = text.replace(/> \*\*回复：(.*?)\*\*/g, '> Reply to: $1');

    return text;
}

// ─── Pre-filter ─────────────────────────────────────────────────────────

/**
 * Quick check to skip obviously non-actionable messages before calling LLM.
 * Only filters when we are VERY confident it's not a signal.
 */
export function isIgnorableMessage(text: string): boolean {
    if (!text) return true;

    const lower = text.toLowerCase().trim();

    // Pure greetings / sign-off
    if (/^(gn|gm|good\s*(morning|night)|see\s*ya)/i.test(lower)) return true;

    // Weekly results announcement (no action)
    if (/will update.*results/i.test(lower)) return true;

    // "No active limits" status
    if (/no active (limits|orders)/i.test(lower)) return true;

    // Pure RR report without any trading action verb
    if (/^\d+(\.\d+)?r(r\+?)?$/i.test(lower)) return true;

    return false;
}

// ─── Text Normalization ─────────────────────────────────────────────────

export function escapeXML(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function isShortManagementText(content: string): boolean {
    const text = extractEnglishText(content || '').trim().toLowerCase();
    if (!text) return false;

    const flattened = text.replace(/\s+/g, ' ');
    const isShort = flattened.length <= 80;
    const hasManagementKeyword =
        /\b(tp|tp1|tp2|tp3|close|closing|update|cancel|remove limit|stopped|stopped out)\b/i.test(flattened);

    return isShort && hasManagementKeyword;
}

// ─── Value Parsing ──────────────────────────────────────────────────────

export function parseNumericValue(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const cleaned = value
        .replace(/[$,]/g, '')
        .replace(/\s+/g, '')
        .trim();
    if (!cleaned) return undefined;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeStopLossValue(value: unknown): number | 'breakeven' | null {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (/^(breakeven|break-even|break even|b\/e)$/.test(normalized)) {
            return 'breakeven';
        }
    }
    const numeric = parseNumericValue(value);
    return typeof numeric === 'number' ? numeric : null;
}

export function resolveRiskMultiplier(rawMessage: any): number | undefined {
    const text = extractEnglishText(String(rawMessage?.content || '')).toLowerCase();
    if (!text) return undefined;

    if (/\blow\s+risk\b|\breduced\s+risk\b/.test(text)) return 0.5;
    if (/\bquarter\s+size\b/.test(text)) return 0.25;
    if (/\bhalf\s+size\b/.test(text)) return 0.5;
    if (/\bfull\s+size\b/.test(text)) return 1.0;

    const rMatch = text.match(/\b(0?\.\d+|[12](?:\.0+)?)\s*r\b/);
    if (rMatch && !/\b(up|rr|profit|gain|payed|paid|already)\b/.test(text)) {
        const value = Number.parseFloat(rMatch[1]);
        if (Number.isFinite(value) && value > 0 && value <= 2) {
            return value;
        }
    }

    const percentMatch = text.match(/\b(0?\.\d+|[12](?:\.0+)?)\s*%/);
    if (!percentMatch) return undefined;

    const value = Number.parseFloat(percentMatch[1]);
    if (!Number.isFinite(value)) return undefined;

    const likelySizingContext =
        /\b(longed|shorted|long|short|entry|entered|risk|risked|scalp|trying|low risk|half size|quarter size|full size)\b/.test(text) &&
        !/\b(target|move|pump|dump|dropped|gain|profit|out|partial|tp)\b/.test(text);

    if (!likelySizingContext) return undefined;
    if (value > 0 && value <= 2) return value;
    return undefined;
}

// ─── Management Context ─────────────────────────────────────────────────

export interface ManagementContext {
    englishText: string;
    hasTpShorthand: boolean;
    hasTakeProfitIntent: boolean;
    hasBreakevenWord: boolean;
    hasCloseVerb: boolean;
    hasPartialWord: boolean;
    isExplicitFullClose: boolean;
    partialClosePercentage?: number;
    explicitClosePercentage?: number;
}

export function analyzeManagementContext(rawMessage: any): ManagementContext {
    const content = String(rawMessage?.content || '');
    const englishText = extractEnglishText(content).toLowerCase();
    const hasTpShorthand = /\btp\s*[1-9]\d?\b|\btp[1-9]\d?\b/.test(englishText);
    const hasTakeProfitIntent = /\b(tp|take[\s-]*profit)\b/.test(englishText);
    const hasBreakevenWord = /\b(breakeven|break[\s-]*even|b\/e|stops?\s+be)\b/.test(englishText);
    const hasPartialWord = /\b(partialed|partials?|trim|trimmed|out|runner|runners)\b/.test(englishText);
    const hasCloseVerb = /\b(close|closing|closed|exit|exiting|stopped|stopped out|stop(ped)? out|trim|partialed|partials?|out)\b/.test(englishText);
    const explicitClosePercentage = extractClosePercentageFromText(englishText);
    const isExplicitFullClose = /\b(close all|fully closed|full close|full closed|closing full|closed full|full tp|all out|stopped out|stop(ped)? out|100%)\b/.test(englishText);
    const partialClosePercentage = resolvePartialClosePercentage(englishText, explicitClosePercentage);
    return {
        englishText,
        hasTpShorthand,
        hasTakeProfitIntent,
        hasBreakevenWord,
        hasCloseVerb,
        hasPartialWord,
        isExplicitFullClose,
        partialClosePercentage,
        explicitClosePercentage
    };
}

export function extractClosePercentageFromText(text: string, allowSizingHints: boolean = false): number | undefined {
    const match = text.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/);
    if (!match) return undefined;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) return undefined;
    if (!allowSizingHints && value <= 2 && !/\b(close|closing|closed|exit|exiting|take profit|tp|out|partial|partials|trim|trimmed)\b/.test(text)) {
        return undefined;
    }
    return Math.max(0, Math.min(100, value));
}

export function resolvePartialClosePercentage(text: string, explicitClosePercentage?: number): number | undefined {
    if (typeof explicitClosePercentage === 'number') return explicitClosePercentage;
    if (!/\b(partialed|partials?|trim|trimmed|out|runner|runners)\b/.test(text)) return undefined;
    if (/\b(major|most|mostly)\s+(partials?|out)\b|\b(closing|closed|taking|took)\s+most\b|\bleaving\s+runners?\b/.test(text)) {
        return 80;
    }
    if (/\bhalf\s+(out|off|closed)\b/.test(text)) {
        return 50;
    }
    if (/\b(partialed|partials?|trim|trimmed)\b/.test(text)) {
        return 50;
    }
    return undefined;
}

// ─── Strategy Comparison ────────────────────────────────────────────────

export function areStrategiesEqual(a: ParsedStrategy[] | null, b: ParsedStrategy[] | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const clean = (s: ParsedStrategy) => { const { raw, ...rest } = s; return rest; };
    return JSON.stringify(a.map(clean)) === JSON.stringify(b.map(clean));
}

// ─── Dedup ──────────────────────────────────────────────────────────────

export interface DedupInfo {
    key: string;
    keyHash: string;
    type: 'message_id' | 'fallback';
    hasAttachmentFingerprint: boolean;
}

export function buildDedupInfo(msg: DiscordMessage, attachments: any[]): DedupInfo {
    const normalizedContent = String(msg.content || '').trim();
    const attachmentFingerprint = buildAttachmentFingerprint(attachments);
    const hasAttachmentFingerprint = attachmentFingerprint.length > 0;

    let rawKey = '';
    let type: 'message_id' | 'fallback' = 'fallback';

    if (msg.id) {
        rawKey = `mid:${msg.id}|content:${normalizedContent}|att:${attachmentFingerprint}`;
        type = 'message_id';
    } else {
        const tsRaw = (msg as any)?.timestamp ?? (msg as any)?.ts ?? Date.now();
        const tsMs = Number(new Date(tsRaw).getTime()) || Date.now();
        const bucket = Math.floor(tsMs / 30000); // 30s bucket to absorb near-duplicate webhook retries
        rawKey = `fallback:${msg.channel_id || 'unknown'}:${bucket}:${normalizedContent}|att:${attachmentFingerprint}`;
    }

    return {
        key: rawKey,
        keyHash: crypto.createHash('md5').update(rawKey).digest('hex'),
        type,
        hasAttachmentFingerprint
    };
}

export function buildAttachmentFingerprint(attachments: any[]): string {
    if (!attachments || attachments.length === 0) return '';

    const fingerprints = attachments
        .map((a: any) => {
            const source = String(a?.url || a?.proxy_url || a?.id || '').trim();
            if (!source) return '';
            return crypto.createHash('sha256').update(source).digest('hex');
        })
        .filter(Boolean)
        .sort();

    return fingerprints.join(',');
}
