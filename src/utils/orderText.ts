import { createHash } from 'crypto';

const GATE_ORDER_TEXT_MAX_LENGTH = 30;
const GATE_ORDER_TEXT_PAYLOAD_MAX_BYTES = 28;
const GATE_ORDER_TEXT_ALLOWED_CHARS = /[^A-Za-z0-9_.-]/g;

export function buildTakeProfitOrderText(tpIndex: number, orderId: string): string {
  const fullText = `t-tp-${tpIndex}-ord-${orderId}`;
  if (fullText.length <= GATE_ORDER_TEXT_MAX_LENGTH) {
    return fullText;
  }

  return `t-tp-${tpIndex}-${orderId}`;
}

export function extractLinkedOrderIdFromText(text?: string | null): string | null {
  if (!text) {
    return null;
  }

  const orderMatch = text.match(/-ord-(\d+)$/);
  if (orderMatch) {
    return orderMatch[1];
  }

  // compact format: t-tp-{index}-{orderId}
  const compactMatch = text.match(/^t-tp-(\d+)-(\d+)$/);
  if (compactMatch) {
    return compactMatch[2];
  }

  return null;
}

export function extractTpIndexFromText(text?: string | null): number | null {
  if (!text) {
    return null;
  }

  // Match both formats: t-tp-{index}-ord-{orderId} or t-tp-{index}-{orderId}
  const match = text.match(/^t-tp-(\d+)-/);
  if (match) {
    const index = parseInt(match[1], 10);
    return Number.isFinite(index) && index > 0 ? index : null;
  }

  return null;
}

export function ensureGateOrderText(text?: string | null, fallback: string = 'trader'): string {
  const raw = String(text || fallback || 'trader');
  if (raw.startsWith('t-')) {
    return raw;
  }

  const sanitized = raw.replace(GATE_ORDER_TEXT_ALLOWED_CHARS, '-').replace(/^-+|-+$/g, '') || fallback || 'trader';
  const fullText = `t-${sanitized}`;
  if (Buffer.byteLength(fullText.replace(/^t-/, ''), 'utf8') <= GATE_ORDER_TEXT_PAYLOAD_MAX_BYTES) {
    return fullText;
  }

  const readablePrefix = sanitized.slice(0, 8).replace(/-+$/g, '') || fallback || 'trader';
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `t-${readablePrefix}-${hash}`;
}

/**
 * 解析 PendingProtection.tpOrdersJson。
 *
 * 兼容两种格式：
 * - 旧格式：`[{price, amount}, ...]` 数组
 * - 新格式：`{ tpOrders: [{price, amount}, ...], attachedSl: boolean }`
 *   attachedSl 表示入场单已通过 tpsl_sl_trigger_price 自带止损，
 *   保护管线无需（也不得）再挂 SL。
 */
export function parseTpOrdersJson(json?: string | null): { tpOrders: { price: string; amount: string }[]; attachedSl: boolean } {
  if (!json) {
    return { tpOrders: [], attachedSl: false };
  }
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return { tpOrders: parsed, attachedSl: false };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tpOrders)) {
      return { tpOrders: parsed.tpOrders, attachedSl: parsed.attachedSl === true };
    }
    return { tpOrders: [], attachedSl: false };
  } catch {
    return { tpOrders: [], attachedSl: false };
  }
}

/** 构造 tpOrdersJson（带 attachedSl 标记时使用对象格式，否则保持旧数组格式）。 */
export function buildTpOrdersJson(tpOrders?: { price: string; amount: string }[] | null, attachedSl = false): string | null {
  if (!tpOrders || tpOrders.length === 0) {
    return null;
  }
  return attachedSl
    ? JSON.stringify({ tpOrders, attachedSl: true })
    : JSON.stringify(tpOrders);
}

export { GATE_ORDER_TEXT_MAX_LENGTH };
