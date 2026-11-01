import { Op } from 'sequelize';
import logger, { formatError } from '../../utils/logger';
import { AILog, Strategy, Order } from '../../models';
import { escapeXML, extractEnglishText } from './RaizexbtTextMatchers';
import type { LLMResult } from './RaizexbtAiPrompts';

/**
 * Reply-chain context for Discord signal parsers.
 *
 * The trading webhook does not include the referenced message body
 * (`referenced_content` is empty); it only embeds a
 * `https://discord.com/channels/<guild>/<channel>/<message_id>` link.
 * Management messages ("stops to entry", "cutting here", "tp1") are usually
 * replies, so without resolving that link the LLM has to guess which symbol
 * the message refers to (and the guess is frequently wrong).
 *
 * This resolver walks the quote chain (up to `maxDepth` hops), loads the
 * quoted message bodies from persisted AI logs / strategies, and finds the
 * originating signal + its latest order so the prompt and the executor both
 * know the target position and whether its entry has already filled.
 */

export interface ReplyChainMessage {
  id: string;
  content: string;
  author?: string;
  referencedIds: string[];
  depth: number;
}

export interface ReplyOrigin {
  messageId: string;
  strategyId: number | null;
  symbol: string | null;
  side: string | null;
  action: string | null;
  entryPrice: string | null;
  stopLoss: string | null;
  orderId: number | null;
  exchangeOrderId: string | null;
  orderStatus: string | null;
  lifecycleStatus: string | null;
}

export interface ReplyContext {
  chain: ReplyChainMessage[];
  origin: ReplyOrigin | null;
  symbol: string | null;
}

export interface ReplyMessageLookupResult {
  id: string;
  content: string;
  author?: string;
}

export type ReplyMessageLookup = (id: string) => Promise<ReplyMessageLookupResult | null>;

const MAX_CONTENT_CHARS = 700;

function emptyContext(): ReplyContext {
  return { chain: [], origin: null, symbol: null };
}

function toMessageObject(raw: unknown): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** Extract every Discord message id referenced by `content` / reference fields. */
export function extractReferenceIds(input: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const push = (value: unknown) => {
    const id = asString(value).trim();
    if (!/^\d{5,}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const message = toMessageObject(input) || (typeof input === 'string' ? { content: input } : null);
  const content = asString(message?.content);

  if (content) {
    // Local regex: module-level global regexes share `lastIndex` and would race
    // when several messages are parsed concurrently.
    const linkRe = /discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(content)) !== null) {
      push(match[1]);
    }
  }

  for (const key of ['reference', 'message_reference', 'messageReference', 'reply_to', 'replyTo']) {
    const ref = message?.[key];
    if (!ref) continue;
    if (typeof ref === 'string' || typeof ref === 'number') push(ref);
    else push(ref.message_id ?? ref.messageId ?? ref.id);
  }

  for (const key of ['referenced_message', 'referencedMessage']) {
    const ref = message?.[key];
    if (ref) push(ref.id);
  }

  return ids;
}

/**
 * Default lookup backed by persisted AI logs (every parsed message is stored
 * there with its full webhook payload) with `strategies.rawMessage` as a
 * fallback for signal messages.
 */
export const defaultReplyMessageLookup: ReplyMessageLookup = async (id: string) => {
  const like = `%"id":"${id}"%`;

  try {
    const logs = await AILog.findAll({
      where: { originalMessage: { [Op.like]: like } },
      order: [['id', 'DESC']],
      limit: 5,
    });
    for (const log of logs) {
      const message = toMessageObject(log.originalMessage);
      if (!message || asString(message.id) !== id) continue;
      const content = asString(message.content);
      if (!content) continue;
      return { id, content, author: asString(message.username) || undefined };
    }
  } catch (error: any) {
    logger.warn('[ReplyContext] ai_logs lookup failed', formatError(error, { id }));
  }

  try {
    const strategy = await Strategy.findOne({
      where: { rawMessage: { [Op.like]: like } },
      order: [['id', 'DESC']],
    });
    const message = toMessageObject(strategy?.rawMessage);
    if (message && asString(message.id) === id) {
      const content = asString(message.content);
      if (content) return { id, content, author: asString(message.username) || undefined };
    }
  } catch (error: any) {
    logger.warn('[ReplyContext] strategies lookup failed', formatError(error, { id }));
  }

  return null;
};

export type ReplyOriginStrategyLookup = (messageId: string) => Promise<Strategy | null>;

export const defaultReplyOriginStrategyLookup: ReplyOriginStrategyLookup = async (messageId: string) => {
  try {
    return await Strategy.findOne({
      where: { rawMessage: { [Op.like]: `%"id":"${messageId}"%` } },
      order: [['id', 'DESC']],
    });
  } catch (error: any) {
    logger.warn('[ReplyContext] strategy lookup failed', formatError(error, { messageId }));
    return null;
  }
};

export class ReplyContextResolver {
  constructor(
    private readonly lookup: ReplyMessageLookup = defaultReplyMessageLookup,
    private readonly maxDepth = 3,
    private readonly maxMessages = 6,
    private readonly strategyLookup: ReplyOriginStrategyLookup = defaultReplyOriginStrategyLookup,
  ) {}

  async resolve(message: any): Promise<ReplyContext> {
    try {
      const initialIds = extractReferenceIds(message);
      if (initialIds.length === 0) return emptyContext();

      const chain: ReplyChainMessage[] = [];
      const visited = new Set<string>();
      const queue: Array<{ id: string; depth: number }> = initialIds.map((id) => ({ id, depth: 1 }));

      while (queue.length > 0 && chain.length < this.maxMessages) {
        const { id, depth } = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);

        const loaded = await this.lookup(id);
        if (!loaded) continue;

        const referencedIds = extractReferenceIds(loaded.content);
        chain.push({
          id: loaded.id,
          content: loaded.content,
          author: loaded.author,
          referencedIds,
          depth,
        });

        if (depth >= this.maxDepth) continue;
        for (const ref of referencedIds) {
          if (!visited.has(ref)) queue.push({ id: ref, depth: depth + 1 });
        }
      }

      if (chain.length === 0) return emptyContext();

      const origin = await this.findOrigin(chain);
      return {
        chain,
        origin,
        symbol: origin?.symbol ?? null,
      };
    } catch (error: any) {
      logger.warn('[ReplyContext] resolve failed', formatError(error));
      return emptyContext();
    }
  }

  private async findOrigin(chain: ReplyChainMessage[]): Promise<ReplyOrigin | null> {
    let matched: { strategy: Strategy; message: ReplyChainMessage } | null = null;

    for (const message of chain) {
      const strategy = await this.findStrategyForMessage(message.id);
      if (!strategy) continue;

      // Prefer the original open signal; management messages have their own
      // strategy rows and must not be used as the position origin.
      if (strategy.action === 'open') {
        matched = { strategy, message };
        break;
      }
      if (!matched) matched = { strategy, message };
    }

    if (!matched) return null;

    const order = await Order.findOne({
      where: { strategyId: matched.strategy.id },
      order: [['createdAt', 'DESC']],
    });

    return {
      messageId: matched.message.id,
      strategyId: matched.strategy.id,
      symbol: matched.strategy.symbol || order?.symbol || null,
      side: matched.strategy.side || order?.side || null,
      action: matched.strategy.action || null,
      entryPrice: matched.strategy.entryPrice || order?.price || null,
      stopLoss: matched.strategy.stopLoss || order?.initialSl || null,
      orderId: order?.id ?? null,
      exchangeOrderId: order?.exchangeOrderId ?? null,
      orderStatus: order?.status ?? null,
      lifecycleStatus: order?.lifecycleStatus ?? null,
    };
  }

  private async findStrategyForMessage(messageId: string): Promise<Strategy | null> {
    return this.strategyLookup(messageId);
  }
}

export const replyContextResolver = new ReplyContextResolver();

// ─── Prompt rendering ────────────────────────────────────────────────────

export function formatReplyContextXml(context: ReplyContext | null | undefined): string {
  if (!context || context.chain.length === 0) return '';

  const lines: string[] = ['<reply_to>'];
  for (const message of context.chain) {
    const text = extractEnglishText(message.content || '').slice(0, MAX_CONTENT_CHARS) || '(empty)';
    lines.push(
      `  <referenced_message id="${escapeXML(message.id)}" depth="${message.depth}"` +
      (message.author ? ` author="${escapeXML(message.author)}"` : '') +
      `>\n    <text>${escapeXML(text)}</text>\n  </referenced_message>`
    );
  }

  const origin = context.origin;
  if (origin) {
    const attrs: string[] = [
      `id="${escapeXML(origin.messageId)}"`,
      `symbol="${escapeXML(origin.symbol || '')}"`,
      `side="${escapeXML(origin.side || '')}"`,
      `action="${escapeXML(origin.action || '')}"`,
      `strategy_id="${origin.strategyId ?? ''}"`,
      `entry_price="${escapeXML(origin.entryPrice || '')}"`,
      `stop_loss="${escapeXML(origin.stopLoss || '')}"`,
      `order_id="${origin.orderId ?? ''}"`,
      `order_status="${escapeXML(origin.orderStatus || '')}"`,
      `lifecycle_status="${escapeXML(origin.lifecycleStatus || '')}"`,
    ];
    lines.push(`  <origin_signal ${attrs.join(' ')} />`);
  }

  lines.push('</reply_to>');
  return lines.join('\n');
}

// ─── Target resolution helpers ───────────────────────────────────────────

const TICKER_ALIASES = new Set([
  'BTC', 'ETH', 'SOL', 'TAO', 'XAU', 'XAG', 'GOLD', 'DOGE', 'SUI', 'ENA',
  'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'TON', 'NEAR', 'APT', 'ARB', 'OP',
  'WIF', 'PEPE', 'TRX', 'LTC', 'BCH', 'DOT', 'UNI', 'AAVE', 'ORDI', 'SEI',
  'TIA', 'INJ', 'FET', 'RNDR', 'JUP', 'PYTH', 'STRK', 'WLD', 'ONDO',
]);

function normalizeTicker(raw: string): string | null {
  let base = String(raw || '').toUpperCase().replace(/^[\s$€¥£]+/, '').trim();
  if (!base) return null;
  if (base.endsWith('USDT')) base = base.slice(0, -4);
  else if (base.endsWith('USD')) base = base.slice(0, -3);
  if (base === 'GOLD') base = 'XAU';
  if (!/^[A-Z]{2,10}$/.test(base)) return null;
  return `${base}_USDT`;
}

/** Symbols explicitly written in the message (e.g. `$BTC`, `$TAO`). */
export function detectMentionedSymbols(text: string): string[] {
  const found = new Set<string>();
  if (!text) return [];

  const dollarRe = /(?:\$|€|¥|£)\s*([A-Za-z]{2,10})\b/g;
  let match: RegExpExecArray | null;
  while ((match = dollarRe.exec(text)) !== null) {
    const symbol = normalizeTicker(match[1]);
    if (symbol) found.add(symbol);
  }

  const bareRe = /\b([A-Za-z]{2,10})\b/g;
  while ((match = bareRe.exec(text)) !== null) {
    const upper = match[1].toUpperCase();
    if (!TICKER_ALIASES.has(upper)) continue;
    const symbol = normalizeTicker(upper);
    if (symbol) found.add(symbol);
  }

  return Array.from(found);
}

/**
 * Fill in the target symbol / order ids from the reply chain.
 * Runs for management actions only; open signals keep the LLM result.
 */
export function applyReplyTargetToResult(
  result: LLMResult,
  currentText: string,
  context: ReplyContext | null | undefined,
): void {
  if (!result || !context?.origin) return;
  if (!['close', 'update', 'cancel'].includes(result.action)) return;

  const mentioned = detectMentionedSymbols(currentText || '');
  const originSymbol = context.origin.symbol;

  if (originSymbol && (!result.symbol || !mentioned.includes(result.symbol))) {
    result.symbol = originSymbol;
  }

  result.referencedSymbol = originSymbol || result.referencedSymbol;
  result.replyStrategyId = context.origin.strategyId;
  result.replyOrderId = context.origin.orderId;
  result.replyOrderStatus = context.origin.lifecycleStatus;
}

/**
 * Last-resort deterministic parsing when the LLM reply cannot be parsed even
 * after a repair retry. Only handles unambiguous management verbs and only
 * when the reply chain gives us a concrete symbol, so it cannot invent trades.
 */
export function buildManagementFallback(
  text: string,
  context: ReplyContext | null | undefined,
): LLMResult | null {
  const symbol = context?.origin?.symbol;
  if (!symbol || !text) return null;

  const lower = text.toLowerCase();

  if (/\b(good cut|results?|recap|monthly|this month)\b/.test(lower)) return null;

  if (/\b(cutting|cut here|cutting here|closing here|close all|fully closed|all out|exiting|exited|took it off)\b/.test(lower)) {
    return {
      action: 'close',
      symbol,
      closePercentage: 100,
      confidence: 0.4,
      reasoning: 'Deterministic fallback: management close verb in a reply to an active signal.',
      referencedSymbol: symbol,
      replyStrategyId: context?.origin?.strategyId ?? null,
      replyOrderId: context?.origin?.orderId ?? null,
      replyOrderStatus: context?.origin?.lifecycleStatus ?? null,
    };
  }

  if (/\b(stops? (to|at) (entry|be|breakeven)|sl to (entry|be|breakeven)|stop to entry|move stop to (entry|be|breakeven))\b/.test(lower)) {
    return {
      action: 'update',
      symbol,
      stopLoss: 'breakeven',
      confidence: 0.4,
      reasoning: 'Deterministic fallback: stop-to-entry/breakeven in a reply to an active signal.',
      referencedSymbol: symbol,
      replyStrategyId: context?.origin?.strategyId ?? null,
      replyOrderId: context?.origin?.orderId ?? null,
      replyOrderStatus: context?.origin?.lifecycleStatus ?? null,
    };
  }

  return null;
}
