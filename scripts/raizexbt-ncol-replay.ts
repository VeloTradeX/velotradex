/**
 * Raizexbt N 列修正离线回放工具。
 *
 * 读取「手动修正-N列」Excel（或普通 raizexbt_signals_*.xlsx），按真实到达顺序把
 * 653 条历史报文重新喂给生产版 RaizexbtParser：
 * - LLM 响应使用 Excel 里的「LLM原始输出」（不发起真实 AI 调用）；
 * - 图片下载、持仓/行情、Discord 回复链全部用 Excel 数据 mock；
 * - 输出「原始解析结果 vs 修复后解析结果」的差异报告，用于确认：
 *   1) N 列标注的问题确实被修复；
 *   2) 没有被 N 列标注的其他消息没有被误伤。
 *
 * 用法：
 *   npx ts-node scripts/raizexbt-ncol-replay.ts \
 *     --xlsx "/path/to/手动修正-N列-raizexbt_signals_2026-10-01_to_2026-11-24.xlsx" \
 *     --out .work/raizexbt_ncol_replay_report.json
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx-js-style';
import { RaizexbtParser } from '../src/services/parsers/RaizexbtParser';
import aiParserService from '../src/services/AIParserService';
import marketService from '../src/services/MarketService';
import { replyContextResolver } from '../src/services/parsers/ReplyContextResolver';
import { ParsedStrategy } from '../src/services/parsers/types';

interface ReplayRow {
    seq: number;
    id: string;
    ts: number;
    content: string;
    hasImage: boolean;
    llm: Record<string, any> | null;
    llmStatus: string;
    replyTo: {
        id: string;
        seq: number;
        symbol: string | null;
        side: string | null;
        action: string | null;
        lifecycleStatus: string;
    } | null;
    excelType: string;
    excelAction: string;
    excelManual: string;
    excelStrategies: any[];
}

function parseArgs(argv: string[]): { xlsx: string; out: string } {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            out[arg.slice(2)] = argv[i + 1];
            i++;
        }
    }
    const xlsx = out.xlsx;
    if (!xlsx) throw new Error('Missing --xlsx <path>');
    return {
        xlsx,
        out: out.out || path.resolve(process.cwd(), '.work', 'raizexbt_ncol_replay_report.json'),
    };
}

function utcMs(beijingTime: string): number {
    const [datePart, timePart] = String(beijingTime).trim().split(' ');
    if (!datePart || !timePart) return Date.now();
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm, ss] = timePart.split(':').map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1, (hh || 0) - 8, mm || 0, ss || 0);
}

function lifecycleFromResult(result: string): string {
    const text = String(result || '');
    if (text.includes('unfilled') && !text.replace(/unfilled/g, '').includes('filled')) return 'PENDING';
    if (text.includes('filled')) return 'OPEN';
    return 'PENDING';
}

function safeJson(value: any): any {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

function loadRows(xlsxPath: string): ReplayRow[] {
    const workbook = XLSX.readFile(xlsxPath);
    const sheet = workbook.Sheets['信号明细'] || workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const byId = new Map<string, any>();
    for (const row of jsonRows) {
        byId.set(String(row['Message ID'] || ''), row);
    }

    const rows: ReplayRow[] = [];
    for (const row of jsonRows) {
        const seq = Number(row['序号']);
        if (!Number.isFinite(seq)) continue;
        const content = String(row['原始消息内容'] || '');
        const llm = safeJson(row['LLM原始输出']);
        let replyTo: ReplayRow['replyTo'] = null;
        const link = content.match(/discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/);
        if (link) {
            const origin = byId.get(link[1]);
            if (origin) {
                replyTo = {
                    id: link[1],
                    seq: Number(origin['序号']),
                    symbol: origin['标的'] ? String(origin['标的']) : null,
                    side: origin['方向'] ? String(origin['方向']) : null,
                    action: origin['AI动作'] ? String(origin['AI动作']) : null,
                    lifecycleStatus: lifecycleFromResult(String(origin['执行结果'] || '')),
                };
            }
        }
        rows.push({
            seq,
            id: String(row['Message ID'] || ''),
            ts: utcMs(String(row['消息时间（北京时间）'] || '')),
            content,
            hasImage: String(row['是否有图片'] || '') === '是',
            llm,
            llmStatus: String(row['LLM状态'] || ''),
            replyTo,
            excelType: String(row['解析结果类型'] || ''),
            excelAction: String(row['AI动作'] || ''),
            excelManual: String(row['手动修正'] || ''),
            excelStrategies: safeJson(row['解析策略明细（JSON）']) || [],
        });
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows;
}

function summarize(strategies: ParsedStrategy[] | null) {
    if (!strategies || strategies.length === 0) return [];
    return strategies.map(strategy => {
        const { raw, ...rest } = strategy as any;
        return rest;
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const rows = loadRows(args.xlsx);
    console.info(`Loaded ${rows.length} messages from ${args.xlsx}`);

    const llmById = new Map<string, Record<string, any> | null>();
    for (const row of rows) llmById.set(row.id, row.llm);

    // ── Mock 外部依赖 ──────────────────────────────────────────────────
    (aiParserService as any).isConfigured = () => true;
    (aiParserService as any).buildPositions = async () => '<positions>\n  <empty>No active positions</empty>\n</positions>';
    (marketService as any).getCommonMarketPricesXml = async () => '';
    (replyContextResolver as any).resolve = async (message: any) => {
        const row = rows.find(item => item.id === String(message?.id));
        if (!row?.replyTo) return { chain: [], origin: null, symbol: null };
        const origin = row.replyTo;
        return {
            chain: [{ id: origin.id, content: `$${origin.symbol || 'UNKNOWN'}`, referencedIds: [], depth: 1 }],
            origin: {
                messageId: origin.id,
                strategyId: origin.seq * 10,
                symbol: origin.symbol,
                side: origin.side,
                action: origin.action,
                entryPrice: null,
                stopLoss: null,
                orderId: origin.seq * 10 + 1,
                exchangeOrderId: `ex-${origin.seq * 10 + 1}`,
                orderStatus: origin.lifecycleStatus,
                lifecycleStatus: origin.lifecycleStatus,
            },
            symbol: origin.symbol,
        };
    };
    (aiParserService as any).analyzeRaw = async (params: any) => {
        const id = String(params?.originalMessage?.id ?? '');
        const llm = llmById.get(id);
        if (!llm) throw new Error(`Unexpected LLM call for replay message ${id}`);
        return {
            content: JSON.stringify(llm),
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            raw: { id: `replay-${id}` },
            logId: 1,
        };
    };
    (RaizexbtParser.prototype as any).downloadImageAsBase64 = async () => 'ZmFrZS1pbWFnZQ==';

    const parser = new RaizexbtParser();
    const records: any[] = [];
    for (const row of rows) {
        const message = {
            id: row.id,
            channel_id: 'raizexbt-replay',
            content: row.content,
            ts: row.ts,
            username: 'raizelxbt',
            attachments: row.hasImage
                ? [{ url: `https://cdn.example.com/${row.id}.jpg`, proxy_url: `https://cdn.example.com/${row.id}.jpg`, is_image: true }]
                : [],
        };
        let strategies: ParsedStrategy[] | null = null;
        try {
            strategies = await parser.parse(message);
        } catch (error: any) {
            strategies = null;
            console.warn(`parse error for #${row.seq}:`, error?.message);
        }
        const newStrategies = summarize(strategies);
        const newActions = newStrategies.map((item: any) => item.action);
        const oldActions = row.excelStrategies.map((item: any) => item.action);
        records.push({
            seq: row.seq,
            id: row.id,
            oldType: row.excelType,
            oldActions,
            oldAction: row.excelAction,
            newActions,
            newStrategies,
            excelManual: row.excelManual,
            changed: JSON.stringify(oldActions) !== JSON.stringify(newActions) || newActions.length !== oldActions.length,
        });
    }

    const report = {
        xlsx: args.xlsx,
        generatedAt: new Date().toISOString(),
        total: records.length,
        changedCount: records.filter(item => item.changed).length,
        nonAnnotatedChangedCount: records.filter(item => item.changed && !item.excelManual).length,
        records,
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
    console.info(`Report written to ${args.out}`);
    console.info(`Changed actions: ${report.changedCount}/${report.total} (non-annotated: ${report.nonAnnotatedChangedCount})`);

    if (report.nonAnnotatedChangedCount > 0) {
        console.info('Non-annotated messages whose action sequence changed:');
        for (const item of records.filter(record => record.changed && !record.excelManual)) {
            console.info(`  #${item.seq}: ${JSON.stringify(item.oldActions)} -> ${JSON.stringify(item.newActions)} | ${String(item.newStrategies?.[0]?.symbol || '')}`);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
