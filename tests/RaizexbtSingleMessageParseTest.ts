import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { RaizexbtParser } from '../src/services/parsers/RaizexbtParser';
import { DiscordMessage, ParsedStrategy } from '../src/services/parsers/types';
import aiParserService from '../src/services/AIParserService';

type HistoricalMessage = {
    content: string;
    timestamp: string;
    channel_id: string;
    attachments?: Array<{ url?: string; proxy_url?: string }>;
};

type StrategyView = {
    index: number;
    action: ParsedStrategy['action'];
    symbol: string;
    side: ParsedStrategy['side'] | null;
    orderType: ParsedStrategy['orderType'] | null;
    closePercentage: number | null;
    entryPrice: string | null;
    stopLoss: string | null;
    targets: string[];
    closePrice: string | null;
    closeAmount: string | null;
};

type MessageParseView = {
    index: number;
    timestamp: string;
    strategyCount: number;
    parseDurationMs: number;
    waitAfterMs: number;
    strategies: StrategyView[];
    content: string;
    imageUrl: string | null;
    imageDataUrl: string | null;
};

const ROOT_DIR = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(ROOT_DIR, 'examples', 'raizexbt.json');
const OUTPUT_FILE = path.join(ROOT_DIR, 'examples', 'raizexbt_all_parse_report.md');
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 10000;

function buildDiscordLikeMessage(message: HistoricalMessage, index: number): any {
    const discordMessage: DiscordMessage = {
        id: `raizexbt-single-${index + 1}`,
        channel_id: message.channel_id || 'unknown-channel',
        content: message.content || '',
        ts: message.timestamp || new Date().toISOString(),
        username: 'example_user'
    };

    const attachments = (message.attachments || []).map((attachment) => {
        const url = attachment.proxy_url || attachment.url || '';
        const isImage = /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url);
        return {
            ...attachment,
            is_image: isImage
        };
    });

    return {
        ...discordMessage,
        attachments
    };
}

function toStrategyView(strategies: ParsedStrategy[] | null): StrategyView[] {
    if (!strategies || strategies.length === 0) {
        return [];
    }

    return strategies.map((strategy, idx) => ({
        index: idx + 1,
        action: strategy.action,
        symbol: strategy.symbol,
        side: strategy.side || null,
        orderType: strategy.orderType || null,
        closePercentage: strategy.closePercentage ?? null,
        entryPrice: strategy.entryPrice || null,
        stopLoss: strategy.stopLoss || null,
        targets: strategy.targets || [],
        closePrice: strategy.closePrice || null,
        closeAmount: strategy.closeAmount || null
    }));
}

function toStats(strategyViews: StrategyView[]) {
    const actionStats: Record<string, number> = {
        open: 0,
        close: 0,
        update: 0,
        cancel: 0
    };

    for (const item of strategyViews) {
        actionStats[item.action] = (actionStats[item.action] || 0) + 1;
    }

    return {
        messageCount: 1,
        strategyCount: strategyViews.length,
        actionStats
    };
}

function toGlobalStats(messageReports: MessageParseView[]) {
    const actionStats: Record<string, number> = {
        open: 0,
        close: 0,
        update: 0,
        cancel: 0
    };
    let totalStrategies = 0;
    let ignoredMessages = 0;
    let totalParseDurationMs = 0;

    for (const report of messageReports) {
        totalParseDurationMs += report.parseDurationMs;
        if (report.strategyCount === 0) {
            ignoredMessages += 1;
        }
        for (const strategy of report.strategies) {
            totalStrategies += 1;
            actionStats[strategy.action] = (actionStats[strategy.action] || 0) + 1;
        }
    }

    return {
        messageCount: messageReports.length,
        totalStrategies,
        ignoredMessages,
        totalParseDurationMs,
        actionStats
    };
}

function cleanMessageText(content: string): string {
    if (!content) return '';
    const parts = content.split('--------------');
    return parts[0].trim();
}

function randomDelayMs(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function toImageDataUrl(imageUrl: string): Promise<string | null> {
    if (!imageUrl) return null;
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const mimeType = typeof response.headers?.['content-type'] === 'string'
            ? response.headers['content-type'].split(';')[0]
            : 'image/jpeg';
        const base64 = Buffer.from(response.data).toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMarkdown(input: {
    aiConfigured: boolean;
    messageReports: MessageParseView[];
    globalStats: {
        messageCount: number;
        totalStrategies: number;
        ignoredMessages: number;
        totalParseDurationMs: number;
        actionStats: Record<string, number>;
    };
}) {
    const details = input.messageReports.map((report) => {
        const strategyBlocks = report.strategies.length > 0
            ? report.strategies.map((item) => [
                `- 策略 #${item.index}`,
                `  - action: ${item.action}`,
                `  - symbol: ${item.symbol}`,
                `  - 入场方向: ${item.side || '-'}`,
                `  - 订单类型: ${item.orderType || '-'}`,
                `  - 入场价: ${item.entryPrice || '-'}`,
                `  - 止损: ${item.stopLoss || '-'}`,
                `  - 止盈: ${item.targets.length > 0 ? item.targets.join(', ') : '-'}`,
                `  - closePercentage: ${item.closePercentage ?? '-'}`,
                `  - closePrice: ${item.closePrice || '-'}`,
                `  - closeAmount: ${item.closeAmount || '-'}`
            ].join('\n')).join('\n')
            : '- 无可执行策略（ignore 或未产出策略）';

        const imageBlock = report.imageDataUrl
            ? `![message-${report.index}-image](${report.imageDataUrl})`
            : '无图片或图片下载失败';

        return [
            `### 消息 #${report.index}`,
            `- 时间: ${report.timestamp}`,
            `- parseDurationMs: ${report.parseDurationMs}`,
            `- waitAfterMs: ${report.waitAfterMs}`,
            `- strategyCount: ${report.strategyCount}`,
            `- imageUrl: ${report.imageUrl || '-'}`,
            '',
            '```text',
            report.content || '(empty)',
            '```',
            '',
            '#### 策略列表',
            strategyBlocks,
            '',
            '#### 图片',
            imageBlock
        ].join('\n');
    }).join('\n\n');

    return [
        '# Raizexbt 全量历史消息解析报告',
        '',
        '## 测试范围',
        `- 数据源: \`examples/raizexbt.json\``,
        `- 解析消息数: ${input.globalStats.messageCount}`,
        `- 使用现有 AI 配置: ${input.aiConfigured ? '是' : '否'}`,
        '- 仅进行解析，不执行下单',
        '- 忽略价格相关执行逻辑，仅保留策略语义字段',
        `- 消息间隔: ${MIN_DELAY_MS}ms - ${MAX_DELAY_MS}ms`,
        '',
        '## 汇总统计',
        `- totalParseDurationMs: ${input.globalStats.totalParseDurationMs}`,
        `- totalStrategies: ${input.globalStats.totalStrategies}`,
        `- ignoredMessages: ${input.globalStats.ignoredMessages}`,
        `- open: ${input.globalStats.actionStats.open || 0}`,
        `- close: ${input.globalStats.actionStats.close || 0}`,
        `- update: ${input.globalStats.actionStats.update || 0}`,
        `- cancel: ${input.globalStats.actionStats.cancel || 0}`,
        `- orderExecutionTriggered: false`,
        '',
        '## 逐条解析详情',
        details,
        ''
    ].join('\n');
}

async function run() {
    if (!fs.existsSync(INPUT_FILE)) {
        throw new Error(`Input file not found: ${INPUT_FILE}`);
    }

    const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
    const history = JSON.parse(raw) as HistoricalMessage[];
    await aiParserService.reloadConfig();
    const parser = new RaizexbtParser();

    const messageReports: MessageParseView[] = [];
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        const parseInput = buildDiscordLikeMessage(message, i);
        const imageUrl = (message.attachments && message.attachments[0])
            ? (message.attachments[0].proxy_url || message.attachments[0].url || '')
            : '';
        const imageDataUrl = imageUrl ? await toImageDataUrl(imageUrl) : null;
        const startedAt = Date.now();
        const parsed = await parser.parse(parseInput, true);
        const parseDurationMs = Date.now() - startedAt;
        const strategyViews = toStrategyView(parsed);
        const localStats = toStats(strategyViews);
        const waitAfterMs = i < history.length - 1 ? randomDelayMs(MIN_DELAY_MS, MAX_DELAY_MS) : 0;

        const report: MessageParseView = {
            index: i,
            timestamp: message.timestamp,
            strategyCount: localStats.strategyCount,
            parseDurationMs,
            waitAfterMs,
            strategies: strategyViews,
            content: cleanMessageText(message.content || ''),
            imageUrl: imageUrl || null,
            imageDataUrl
        };
        messageReports.push(report);

        console.log(`[${i + 1}/${history.length}] parsed, strategyCount=${report.strategyCount}, parseDurationMs=${report.parseDurationMs}, waitAfterMs=${waitAfterMs}`);
        if (waitAfterMs > 0) {
            await sleep(waitAfterMs);
        }
    }

    const globalStats = toGlobalStats(messageReports);
    const markdown = buildMarkdown({
        aiConfigured: aiParserService.isConfigured(),
        messageReports,
        globalStats
    });

    fs.writeFileSync(OUTPUT_FILE, markdown, 'utf-8');

    console.log(`Report generated: ${OUTPUT_FILE}`);
    console.log(`AI configured: ${aiParserService.isConfigured()}`);
    console.log(`Messages: ${globalStats.messageCount}`);
    console.log(`Strategies: ${globalStats.totalStrategies}`);
    console.log(`Ignored Messages: ${globalStats.ignoredMessages}`);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
