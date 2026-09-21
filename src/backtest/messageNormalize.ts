/**
 * Discord 消息规范化（回测上传入口共用）。
 *
 * 兼容两类输入：
 * 1. 原始 Discord API 导出（嵌套数组的完整消息对象，如 kacang-source.json）；
 * 2. 已预处理格式（扁平数组，仅 content/attachments/timestamp/channel_id，如 kacang.json）。
 *
 * 输出统一为按 timestamp 升序的 NormalizedMessage[]，
 * 并提供 buildDiscordMessage() 把规范化消息补全为运行时管线所需的完整消息结构
 * （与 scripts/parser-backtest.ts 的构造方式一致：补 id/ts/username/is_image）。
 */

export interface NormalizedAttachment {
  url: string;
  proxy_url: string;
}

export interface NormalizedMessage {
  content: string;
  attachments: NormalizedAttachment[];
  timestamp: string; // ISO
  channel_id: string;
  embeds?: Array<{ description: string }>;
  username?: string;
}

export interface NormalizeResult {
  messages: NormalizedMessage[];
  skipped: number;
  channels: string[];
  rangeStart: string | null;
  rangeEnd: string | null;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const isImageAttachment = (att: any): boolean => {
  const contentType = String(att?.content_type || '');
  const filename = String(att?.filename || '');
  return contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(filename);
};

function normalizeOne(raw: any): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  const timestamp = asString(raw.timestamp);
  const channelId = asString(raw.channel_id);
  if (!timestamp || !channelId) return null;
  if (Number.isNaN(new Date(timestamp).getTime())) return null;

  const content = asString(raw.content);
  const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const attachments: NormalizedAttachment[] = rawAttachments
    .map((att: any) => ({
      url: asString(att?.url),
      proxy_url: asString(att?.proxy_url) || asString(att?.url),
    }))
    .filter((att: NormalizedAttachment) => att.url.length > 0);

  const embeds = Array.isArray(raw.embeds)
    ? raw.embeds
      .map((embed: any) => ({ description: asString(embed?.description) }))
      .filter((embed: { description: string }) => embed.description.length > 0)
    : undefined;

  if (!content && attachments.length === 0 && (!embeds || embeds.length === 0)) return null;

  return {
    content,
    attachments,
    timestamp,
    channel_id: channelId,
    ...(embeds && embeds.length > 0 ? { embeds } : {}),
    ...(raw?.author?.username ? { username: asString(raw.author.username) } : {}),
  };
}

/** 任意形态输入 → 规范化消息（按时间升序，去重 id） */
export function normalizeDiscordMessages(input: unknown): NormalizeResult {
  const flat: any[] = Array.isArray(input)
    ? (input as any[]).flat(Infinity)
    : Array.isArray((input as any)?.messages)
      ? ((input as any).messages as any[]).flat(Infinity)
      : [];

  const seen = new Set<string>();
  const messages: NormalizedMessage[] = [];
  let skipped = 0;

  for (const raw of flat) {
    // 同一消息可能被多份导出重复包含：按内容+时间+频道去重
    const normalized = normalizeOne(raw);
    if (!normalized) {
      skipped++;
      continue;
    }
    const key = `${normalized.channel_id}|${normalized.timestamp}|${normalized.content}|${normalized.attachments.map(a => a.url).join(',')}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    messages.push(normalized);
  }

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const channels = Array.from(new Set(messages.map(m => m.channel_id)));
  return {
    messages,
    skipped,
    channels,
    rangeStart: messages.length > 0 ? messages[0].timestamp : null,
    rangeEnd: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
  };
}

/**
 * 规范化消息 → 运行时管线消息结构（channelMessageHandler/解析器所见形态）。
 * ts 使用 Discord 消息原始时间，保证 Strategy.createdAt 记录为原始信号时间。
 */
export function buildDiscordMessage(normalized: NormalizedMessage, index: number): any {
  return {
    id: `backtest-${index}-${normalized.channel_id}`,
    channel_id: normalized.channel_id,
    content: normalized.content,
    timestamp: normalized.timestamp,
    ts: new Date(normalized.timestamp).getTime(),
    username: normalized.username || 'backtest',
    attachments: normalized.attachments.map(att => ({
      url: att.url,
      proxy_url: att.proxy_url,
      is_image: true,
    })),
    ...(normalized.embeds ? { embeds: normalized.embeds } : {}),
  };
}
