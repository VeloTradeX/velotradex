/**
 * KacangParser — Kacang 交易信号解析器（纯文本程序解析，无 AI）。
 *
 * 行为约定（与 huice/kacang backtest.py 的解析逻辑对齐）：
 * - 只开仓：解析 BUY/SELL XAUUSD（黄金）信号，含入场区间 + TP1/TP2 + SL，开仓后持仓到止盈/止损。
 * - 双层入场：
 *   * Layer 1 市价入场；
 *   * Layer 2 限价入场，限价置于入场区间另一端。
 * - 回复/播报消息（Discord 中文 locale 的 "回复:" 前缀）一律忽略，不产生新开仓。
 * - 缺少方向、入场区间、TP1 或 SL 的消息不是完整开仓信号：若符合「截断信号」特征
 *   （仅保留方向 + "@ 入场价"，TP/SL 缺失），用历史完整信号的均值距离反推补全缺失的
 *   TP1/TP2/SL，并打 warning 日志（sourceType='text_inferred'）；否则忽略。
 *
 * 信号格式示例：
 *   Gold buy now @ 4325 - 4321
 *
 *   tp1 : 4335
 *   tp2 : 4340
 *   sl : 4318
 *
 *   Layer slowly in zone !
 *
 * 说明：本解析器为纯文本确定性解析，不调用任何视觉/LLM，也不依赖图片附件。
 */
import { IStrategyParser, ParsedStrategy, StrategyRiskConfig } from './types';
import logger from '../../utils/logger';

// 回复/引用标记：Discord 中文 locale "回复: [..](..)" 前缀，或引用块 "> quoted text"
const REPLY_PATTERN = /^回复:|^>\s/m;

// 入场区间分隔符：兼容 `-`、连字号、长破折号等写法
const ZONE_RANGE_PATTERN = /@\s*([\d.]+)\s*[-–—]\s*([\d.]+)/;
const ZONE_SINGLE_PATTERN = /@\s*([\d.]+)/;

// 让点（由回测工具在回测阶段按多空方向应用；解析阶段保留信号原始值）
export const TP_SLIPPAGE = 5.5;
export const SL_SLIPPAGE = 0.9;

// ─── 截断信号反推参数（均值法） ───────────────────────────────────────────
// 对缺少 TP/SL 的被截断信号，用历史完整信号的均值距离反推补全缺失值。
// 基准取消息中 "@ 价格"（被截断时保留下来的入场价，= 区间远端 L2 端点）。
// 均值来源：74 条截断信号引用真实值统计（L2 口径）：TP1=10.8 / TP2=16.9 / SL=7.2。
export const INFER_TP1_DIST = 10.8;
export const INFER_TP2_DIST = 16.9;
export const INFER_SL_DIST = 7.2;

/** 从字符串中提取第一个数字（支持小数）。 */
function extractNumber(s: string): number | null {
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

export class KacangParser implements IStrategyParser {
  name = 'KacangParser';

  getRiskConfig(): StrategyRiskConfig {
    return {
      riskMode: 'fixed',
      riskValue: 10,
      defaultLeverage: '20',
      priceTolerance: 0.01,
      entryOrderMode: 'taker',
      tpDistribution: [0.5, 0.5],
      tpOrderType: 'limit',
      tpOrderMode: 'maker',
      autoCloseOppositePosition: true,
      positionSizingMode: 'risk_based',
      // 双层入场（L1 市价 + L2 限价）不允许合并入场价
      entryMergeThresholdR: 0,
    };
  }

  public async parse(message: any, _isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!content) return null;

    // 回复/播报类消息不产生新开仓
    if (REPLY_PATTERN.test(content)) {
      logger.debug(`${this.logPrefix} Reply message, ignoring`, { id: message?.id });
      return null;
    }

    const lines = content.split('\n');

    // ── 方向（BUY/SELL）──
    const header = (lines[0] || '').toLowerCase();
    let side: 'buy' | 'sell' | undefined;
    if (/\bsell\b/.test(header)) side = 'sell';
    else if (/\bbuy\b/.test(header)) side = 'buy';
    if (!side) return null;

    // 手数标签：header 含 double 记双倍手数
    const isDouble = /\bdouble\b/.test(header);

    // ── 入场区间 ──
    let entryLine = '';
    for (const line of lines) {
      if (line.includes('@') && /\d/.test(line)) {
        entryLine = line;
        break;
      }
    }
    if (!entryLine) return null;

    let zoneHigh: number;
    let zoneLow: number;
    const rangeMatch = entryLine.match(ZONE_RANGE_PATTERN);
    if (rangeMatch) {
      const p1 = parseFloat(rangeMatch[1]);
      const p2 = parseFloat(rangeMatch[2]);
      zoneHigh = Math.max(p1, p2);
      zoneLow = Math.min(p1, p2);
    } else {
      const singleMatch = entryLine.match(ZONE_SINGLE_PATTERN);
      if (!singleMatch) return null;
      const p = parseFloat(singleMatch[1]);
      if (side === 'sell') {
        zoneHigh = p + 4;
        zoneLow = p;
      } else {
        zoneHigh = p;
        zoneLow = p - 4;
      }
    }

    // ── TP1 / TP2 / SL（保留信号原始值，让点在回测阶段按方向应用）──
    let tp1: number | null = null;
    let tp2: number | null = null;
    let sl: number | null = null;

    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      if (lower.startsWith('tp1')) {
        const val = extractNumber(lower.includes(':') ? lower.split(':')[1] : lower.includes(';') ? lower.split(';')[1] : '');
        if (val != null) tp1 = val;
      } else if (lower.startsWith('tp2')) {
        const val = extractNumber(lower.includes(':') ? lower.split(':')[1] : lower.includes(';') ? lower.split(';')[1] : lower);
        if (val != null) tp2 = val;
      } else if (lower.startsWith('sl')) {
        const val = extractNumber(lower.includes(':') ? lower.split(':')[1] : lower);
        if (val != null) sl = val;
      }
    }

    // 指定入场价：卖单取区间高点（limit 反向端点），买单取区间低点
    const entryPrice = side === 'sell' ? zoneHigh : zoneLow;
    // Layer 2 限价 = 入场区间另一端
    const l2LimitPrice = side === 'sell' ? zoneLow : zoneHigh;

    // ── 完整开仓信号：有 TP1 和 SL 则直接返回 ──
    if (tp1 != null && sl != null) {
      const targets = tp2 != null ? [tp1, tp2] : [tp1];

      const strategy: ParsedStrategy = {
        action: 'open',
        symbol: 'XAU_USDT',
        side,
        orderType: 'market',
        entryPrice: String(entryPrice),
        targets: targets.map(String),
        stopLoss: String(sl),
        entries: [{ type: 'market' }, { type: 'limit', price: l2LimitPrice }],
        riskMultiplier: isDouble ? 2 : 1,
        sourceType: 'text',
        raw: message,
      };

      logger.debug(`${this.logPrefix} Open signal parsed`, {
        id: message?.id,
        side,
        zone: [zoneHigh, zoneLow],
        tp1,
        tp2,
        sl,
        double: isDouble,
      });
      return [strategy];
    }

    // ── 截断信号检测与反推 ──
    // 条件：有方向 + 有入场价（@ 数字），但 TP1 或 SL 缺失 → 视为截断信号，
    // 用历史完整信号的均值距离反推补全 TP1/TP2/SL，并打 warning 日志。
    const isTruncated = /\b(?:buy|sell)\b/.test(header) && /@\s*\d+/.test(content);
    if (!isTruncated) return null;

    // 提取截断信号中的入场价（基准价 p，= 区间远端 L2 端点：@ 后第一个价格）
    const em = entryLine.match(ZONE_SINGLE_PATTERN) || entryLine.match(ZONE_RANGE_PATTERN);
    if (!em) return null;
    const p = parseFloat(em[1]);
    if (!Number.isFinite(p)) return null;

    // 反推 TP/SL：TP 在有利方向（+buy / -sell），SL 在相反方向
    const sign = side === 'sell' ? -1 : 1;
    const inferredTp1 = Math.round((p + sign * INFER_TP1_DIST) * 100) / 100;
    const inferredTp2 = Math.round((p + sign * INFER_TP2_DIST) * 100) / 100;
    const inferredSl = Math.round((p - sign * INFER_SL_DIST) * 100) / 100;

    const strategy: ParsedStrategy = {
      action: 'open',
      symbol: 'XAU_USDT',
      side,
      orderType: 'market',
      entryPrice: String(entryPrice),
      targets: [inferredTp1, inferredTp2].map(String),
      stopLoss: String(inferredSl),
      entries: [{ type: 'market' }, { type: 'limit', price: l2LimitPrice }],
      riskMultiplier: isDouble ? 2 : 1,
      sourceType: 'text_inferred', // 标记为推测信号，便于事后排查
      raw: message,
    };

    logger.warn(`${this.logPrefix} 疑似截断信号，已用均值反推补全 TP/SL: ${content.slice(0, 80)}`, {
      id: message?.id,
      side,
      truncPrice: p,
      tp1: inferredTp1,
      tp2: inferredTp2,
      sl: inferredSl,
    });
    return [strategy];
  }

  private get logPrefix(): string {
    return 'KacangParser:';
  }
}