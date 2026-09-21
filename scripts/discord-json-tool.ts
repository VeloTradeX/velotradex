/**
 * Discord 消息处理工具脚本。
 *
 * 作用：把原始 Discord API 导出的消息 JSON 规范化，并将消息中的图片附件下载缓存到数据库，
 * 供后续解析器回测使用。
 *
 * 子命令：
 * - preprocess   扁平化、规范化原始 Discord API 响应 JSON，保留 content / attachments / timestamp / channel_id，
 *                按时间排序，支持 --usernames 过滤指定用户，输出规范化 JSON。
 * - wwg          同 preprocess，但只保留 content / timestamp / channel_id / embeds[].description（WWG 解析器专用）。
 * - cache-images 读取规范化 JSON，提取去重后的图片附件 URL，通过代理下载图片并以 base64 存入
 *                image_download_caches 表（ImageDownloadCache 模型），默认输入 examples/soul.json。
 *
 * 典型流程：
 *   npx ts-node scripts/discord-json-tool.ts preprocess <in.json> <out.json>
 *   npx ts-node scripts/discord-json-tool.ts cache-images <out.json>
 * 之后可用 tests/RaizexbtSingleMessageParseTest.ts 等回测脚本消费 out.json 与图片缓存。
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// 图片下载代理：优先读取 DISCORD_PROXY，其次复用标准代理环境变量；未设置则不使用代理。
// 例如：DISCORD_PROXY=http://127.0.0.1:7890 npx ts-node scripts/discord-json-tool.ts cache-images examples/soul.json
const DEFAULT_PROXY = process.env.DISCORD_PROXY || process.env.ALL_PROXY || process.env.HTTPS_PROXY || '';
const DEFAULT_CACHE_INPUT_FILE = 'examples/soul.json';

if (DEFAULT_PROXY) {
  process.env.ALL_PROXY = process.env.ALL_PROXY || DEFAULT_PROXY;
  process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || DEFAULT_PROXY;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || DEFAULT_PROXY;
}

type CliCommand = 'help' | 'preprocess' | 'wwg' | 'cache-images';

type CliOptions = {
  command: CliCommand;
  args: string[];
};

type RawAttachment = {
  url?: unknown;
  proxy_url?: unknown;
};

type RawAuthor = {
  username?: unknown;
};

type RawEmbed = {
  description?: unknown;
};

type RawDiscordMessage = {
  content?: unknown;
  attachments?: RawAttachment[];
  embeds?: RawEmbed[];
  timestamp?: unknown;
  channel_id?: unknown;
  author?: RawAuthor;
};

type NormalizedMessage = {
  content: string;
  attachments: Array<{
    url: string;
    proxy_url: string;
  }>;
  timestamp: string;
  channel_id: string;
};

type WwgNormalizedMessage = {
  content: string;
  timestamp: string;
  channel_id: string;
  embeds: Array<{ description: string }>;
};

export function getCliOptions(args: string[]): CliOptions {
  const normalizedArgs = Array.isArray(args) ? args : [];
  if (
    normalizedArgs.length === 0 ||
    normalizedArgs[0] === '--help' ||
    normalizedArgs[0] === '-h'
  ) {
    return { command: 'help', args: [] };
  }

  const [command, ...rest] = normalizedArgs;
  if (command === 'preprocess' || command === 'wwg' || command === 'cache-images') {
    return { command, args: rest };
  }

  return { command: 'help', args: [] };
}

export function getHelpText(): string {
  return [
    'Usage:',
    '  npx ts-node scripts/discord-json-tool.ts <command> [arguments]',
    '',
    'Commands:',
    '  preprocess    Flatten and normalize raw Discord API response JSON',
    '  wwg           Flatten Discord API response JSON and keep content, timestamp, channel_id, embeds[].description',
    '  cache-images  Download image attachments from normalized message JSON into image_download_caches',
    '',
    'Options:',
    '  -h, --help    Show this help message',
    '',
    'Run `npx ts-node scripts/discord-json-tool.ts <command> --help` for command-specific help.',
  ].join('\n');
}

export function getPreprocessHelpText(): string {
  return [
    'Usage:',
    '  npx ts-node scripts/discord-json-tool.ts preprocess <input-json> <output-json>',
    '',
    'Description:',
    '  Flatten nested Discord API response arrays, keep key fields, and sort by timestamp.',
    '',
    'Options:',
    '  --usernames <usernames>  Comma-separated list of usernames to filter by (filters out messages from other users)',
  ].join('\n');
}

export function getCacheImagesHelpText(): string {
  return [
    'Usage:',
    `  npx ts-node scripts/discord-json-tool.ts cache-images [json-file]`,
    '',
    'Description:',
    `  Download image attachments from normalized message JSON, default input: ${DEFAULT_CACHE_INPUT_FILE}`,
  ].join('\n');
}

export function getWwgHelpText(): string {
  return [
    'Usage:',
    '  npx ts-node scripts/discord-json-tool.ts wwg <input-json> <output-json>',
    '',
    'Description:',
    '  Flatten nested Discord API response arrays, keep only content, timestamp, channel_id, and embeds[].description, then sort by timestamp.',
  ].join('\n');
}

export function extractMessages(input: unknown): RawDiscordMessage[] {
  if (!Array.isArray(input)) {
    throw new Error('Input JSON must be an array or nested arrays of Discord messages');
  }

  return input.flat(Infinity).filter((item): item is RawDiscordMessage => {
    return !!item && typeof item === 'object' && !Array.isArray(item);
  });
}

export function normalizeMessages(messages: RawDiscordMessage[]): NormalizedMessage[] {
  return messages
    .map((message) => {
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      return {
        content: typeof message.content === 'string' ? message.content : '',
        attachments: attachments.map((attachment) => ({
          url: typeof attachment?.url === 'string' ? attachment.url : '',
          proxy_url: typeof attachment?.proxy_url === 'string' ? attachment.proxy_url : '',
        })),
        timestamp: typeof message.timestamp === 'string' ? message.timestamp : '',
        channel_id: typeof message.channel_id === 'string' ? message.channel_id : '',
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function normalizeWwgMessages(messages: RawDiscordMessage[]): WwgNormalizedMessage[] {
  return messages
    .map((message) => {
      const rawEmbeds = Array.isArray(message.embeds) ? message.embeds : [];
      return {
        content: typeof message.content === 'string' ? message.content : '',
        timestamp: typeof message.timestamp === 'string' ? message.timestamp : '',
        channel_id: typeof message.channel_id === 'string' ? message.channel_id : '',
        embeds: rawEmbeds
          .filter((embed): embed is { description: string } => typeof embed?.description === 'string')
          .map((embed) => ({ description: embed.description })),
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadImageUrls(filePath: string): string[] {
  const raw = loadJson(filePath) as NormalizedMessage[];
  const uniqueUrls = new Set<string>();

  for (const message of raw) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      const url = String(attachment.proxy_url || attachment.url || '').trim();
      if (url) {
        uniqueUrls.add(url);
      }
    }
  }

  return Array.from(uniqueUrls);
}

async function downloadImage(url: string): Promise<{ base64: string; mimeType: string | null; sizeBytes: number; }> {
  const proxyUrl = process.env.ALL_PROXY || DEFAULT_PROXY;
  const agent = new HttpsProxyAgent(proxyUrl);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CopyTrader/1.0)',
    },
    httpAgent: agent,
    httpsAgent: agent,
  });

  const buffer = Buffer.from(response.data);
  const mimeTypeHeader = response.headers?.['content-type'];
  const mimeType = typeof mimeTypeHeader === 'string' ? mimeTypeHeader.split(';')[0] : null;

  return {
    base64: buffer.toString('base64'),
    mimeType,
    sizeBytes: buffer.length,
  };
}

function parseUsernamesOption(args: string[]): string[] | undefined {
  const usernamesIndex = args.findIndex((arg) => arg === '--usernames');
  if (usernamesIndex === -1 || usernamesIndex + 1 >= args.length) {
    return undefined;
  }
  const usernamesValue = args[usernamesIndex + 1];
  if (!usernamesValue || usernamesValue.startsWith('-')) {
    return undefined;
  }
  return usernamesValue.split(',').map((u) => u.trim()).filter(Boolean);
}

async function runPreprocessCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(getPreprocessHelpText());
    return;
  }

  const filteredArgs = args.filter((arg) => !arg.startsWith('--usernames'));
  const usernamesToFilter = parseUsernamesOption(args);

  const [inputArg, outputArg] = filteredArgs;
  if (!inputArg || !outputArg) {
    throw new Error('preprocess requires <input-json> and <output-json>');
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  const outputFile = path.resolve(process.cwd(), outputArg);
  const raw = loadJson(inputFile);
  let messages = extractMessages(raw);

  if (usernamesToFilter && usernamesToFilter.length > 0) {
    const usernameSet = new Set(usernamesToFilter);
    messages = messages.filter((msg) => {
      const authorUsername = typeof msg.author?.username === 'string' ? msg.author.username : '';
      return usernameSet.has(authorUsername);
    });
    console.log(`Filtered to ${messages.length} messages from specified users`);
  }

  const normalized = normalizeMessages(messages);

  writeJson(outputFile, normalized);
  console.log(`Preprocessed ${normalized.length} messages to ${outputFile}`);
}

async function runWwgCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(getWwgHelpText());
    return;
  }

  const [inputArg, outputArg] = args;
  if (!inputArg || !outputArg) {
    throw new Error('wwg requires <input-json> and <output-json>');
  }

  const inputFile = path.resolve(process.cwd(), inputArg);
  const outputFile = path.resolve(process.cwd(), outputArg);
  const raw = loadJson(inputFile);
  const messages = extractMessages(raw);
  const normalized = normalizeWwgMessages(messages);

  writeJson(outputFile, normalized);
  console.log(`Preprocessed ${normalized.length} wwg messages to ${outputFile}`);
}

async function runCacheImagesCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(getCacheImagesHelpText());
    return;
  }

  const inputArg = args.find((arg) => !arg.startsWith('-')) || DEFAULT_CACHE_INPUT_FILE;
  const inputFile = path.resolve(process.cwd(), inputArg);
  const urls = loadImageUrls(inputFile);
  const { ImageDownloadCache } = await import('../src/models');

  await ImageDownloadCache.sync();

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  console.log(`Using proxy: ${process.env.ALL_PROXY}`);
  console.log(`Found ${urls.length} unique image URLs in ${inputFile}`);

  const CONCURRENCY = 10;
  let workerIdx = 0;

  async function worker() {
    while (workerIdx < urls.length) {
      const taskIdx = workerIdx++;
      const url = urls[taskIdx];
      const urlHash = crypto.createHash('sha256').update(url).digest('hex');

      try {
        const existing = await ImageDownloadCache.findOne({ where: { urlHash } });
        const image = await downloadImage(url);

        await ImageDownloadCache.upsert({
          url,
          urlHash,
          imageBase64: image.base64,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          hitCount: existing?.hitCount || 0,
          lastAccessedAt: new Date(),
        });

        if (existing) {
          updated++;
        } else {
          inserted++;
        }

        console.log(`[${taskIdx + 1}/${urls.length}] cached ${existing ? 'existing' : 'new'} image (${image.sizeBytes} bytes)`);
      } catch (error: any) {
        failed++;
        console.error(`[${taskIdx + 1}/${urls.length}] failed: ${url}`);
        console.error(error?.message || error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));

  console.log(`Done. inserted=${inserted} updated=${updated} failed=${failed}`);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cliOptions = getCliOptions(argv);

  if (cliOptions.command === 'help') {
    console.log(getHelpText());
    return;
  }

  if (cliOptions.command === 'preprocess') {
    await runPreprocessCommand(cliOptions.args);
    return;
  }

  if (cliOptions.command === 'wwg') {
    await runWwgCommand(cliOptions.args);
    return;
  }

  await runCacheImagesCommand(cliOptions.args);
}

if (require.main === module) {
  const cliOptions = getCliOptions(process.argv.slice(2));
  runCli()
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (
        cliOptions.command !== 'cache-images' ||
        cliOptions.args.includes('--help') ||
        cliOptions.args.includes('-h')
      ) {
        return;
      }
      const { sequelize } = await import('../src/models');
      await sequelize.close();
    });
}
