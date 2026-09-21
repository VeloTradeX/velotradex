/**
 * BacktestEngine —— 回测总控制器（运行于回测子进程内）。
 *
 * 职责（对应用户需求的「总控制器」概念）：
 * 1. 预解析：用路由配置的解析器对导入消息做一次预扫描，收集涉及的交易品种；
 * 2. 建 K 线环境：按品种拉取消息时间范围内的 1m K 线（磁盘缓存）；
 * 3. 逐 K 线重放：把每根 K 线展开为 O→逆行极值→顺行极值→C 四个 tick 注入虚拟
 *    交易所行情 hub，驱动限价成交 / TP / SL 撮合；消息按其原始时间在所属分钟内
 *    的位置插入到 tick 之间，交给原版消息管线（handleChannelMessage）处理；
 *    每注入一批 tick / 每处理完一条消息都等待撮合队列排空（drainTicks + settle），
 *    确保解析、下单、保护单全部落地后才推进时间——顺序确定性重放；
 * 4. 时间戳真实性：推进模拟时钟（Clock.setSimTime）后再触发上述动作，使
 *    Strategy/Order/VirtualTrade 等模块记录的时间 = 原始信号时间 / K 线触发时间；
 * 5. 进度与结果：持续写进度文件供主进程轮询展示；结束后导出结果 JSON，
 *    由主进程 BacktestImportService 导入主库。
 *
 * 与实盘互不干扰：本类仅在回测子进程内实例化；所有共享模块（Clock、
 * MarketDataHub、虚拟交易所）都通过「模拟时间门卫」实现行为切换，
 * 实盘进程中这些门卫均为空操作。
 */
import fs from 'fs';
import path from 'path';
import { BacktestCandle, CandleFetcher } from './CandleFetcher';
import { candleToTicks, priceAtTime } from './TickGenerator';
import { setBacktestPriceProvider, setSimTime, simTimeMs } from './Clock';
import { buildDiscordMessage, normalizeDiscordMessages, NormalizedMessage } from './messageNormalize';
import { handleChannelMessage } from '../channelMessageHandler';
import exchangeRegistry from '../services/exchanges';
import strategyParserRegistry from '../services/parsers';
import aiParserService from '../services/AIParserService';
import { normalizeRouteSymbol } from '../services/RouteParsedStrategy';
import { normalizeSymbolCase } from '../utils/normalizeSymbol';
import { VirtualGateExchange } from '../services/exchanges/virtual/VirtualGateExchange';
import { Strategy, Order, VirtualAccount, VirtualOrder, VirtualPosition, VirtualTrade, AuditLog, AILog, StrategyPosition, SoftStopLoss } from '../models';
import logger, { formatError } from '../utils/logger';

/** 主进程写好的运行配置（config 文件内容） */
export interface BacktestRunConfig {
  runId: number;
  runKey: string;
  name: string;
  messagesPath: string;
  initialBalance: string;
  /** 虚拟交易所 tick 新鲜度窗口（模拟时钟口径），覆盖周末闭市等长间隙 */
  maxTickAgeMs: number;
  parserName: string;
  /** 用户指定的品种提示；非空则跳过预解析 */
  symbolsHint: string[];
  /** 克隆的原始路由行（exchangeInstanceId 已改写为 runKey） */
  route: Record<string, any>;
  parserConfigs: Array<Record<string, any>>;
  aiConfigs: Array<Record<string, any>>;
  imageCaches: Array<Record<string, any>>;
  childDbPath: string;
  redisDb: number;
  progressPath: string;
  resultPath: string;
}

export interface BacktestProgress {
  phase: 'preparing' | 'preParse' | 'fetchCandles' | 'replaying' | 'exporting' | 'done' | 'stopped' | 'failed';
  detail?: string;
  candlesDone?: number;
  candlesTotal?: number;
  messagesProcessed?: number;
  messagesTotal?: number;
  simTime?: string | null;
  error?: string;
  updatedAt: string;
}

const LOOKBACK_MS = 60 * 60 * 1000; // 消息范围前多拉 1 小时 K 线，保证首个信号的当前价可回溯
const PROGRESS_WRITE_INTERVAL_MS = 3000; // 进度文件节流
const TICK_SLOT_OFFSETS_MS = [0, 20_000, 40_000, 59_999]; // 与 TickGenerator.candleToTicks 的锚点一致

export class BacktestEngine {
  private stopRequested = false;
  private messagesProcessed = 0;
  private messagesTotal = 0;
  private lastProgressWriteAt = 0;

  constructor(private readonly cfg: BacktestRunConfig) {}

  /** 外部（SIGTERM 处理器）请求停止：引擎在当前分钟结束后安全收尾 */
  public requestStop(): void {
    this.stopRequested = true;
  }

  public async run(): Promise<void> {
    // ── 1. 消息装载 ──
    const raw = JSON.parse(fs.readFileSync(this.cfg.messagesPath, 'utf8'));
    const normalized = normalizeDiscordMessages(raw);
    if (normalized.messages.length === 0) {
      throw new Error('导入文件中未找到有效消息');
    }
    this.messagesTotal = normalized.messages.length;
    const rangeStartMs = new Date(normalized.rangeStart!).getTime();
    const rangeEndMs = new Date(normalized.rangeEnd!).getTime();
    logger.info(`[BacktestEngine] 消息 ${this.messagesTotal} 条，时间范围 ${normalized.rangeStart} ~ ${normalized.rangeEnd}`);

    // ── 2. 预解析收集品种 ──
    this.writeProgress({ phase: 'preParse', messagesTotal: this.messagesTotal });
    const symbols = this.cfg.symbolsHint.length > 0
      ? Array.from(new Set(this.cfg.symbolsHint.map(normalizeRouteSymbol).filter(Boolean)))
      : await this.collectSymbols(normalized.messages);
    if (symbols.length === 0) {
      throw new Error('未能从消息中解析出任何交易品种（可尝试在表单中手动指定品种）');
    }
    logger.info(`[BacktestEngine] 回测品种: ${symbols.join(', ')}`);

    // ── 3. K 线拉取 ──
    this.writeProgress({ phase: 'fetchCandles', detail: symbols.join(',') });
    const fetchStartSec = Math.floor((rangeStartMs - LOOKBACK_MS) / 1000);
    const fetchEndSec = Math.ceil(rangeEndMs / 1000);
    const fetcher = new CandleFetcher();
    const candlesBySymbol = new Map<string, BacktestCandle[]>();
    for (const symbol of symbols) {
      const candles = await fetcher.fetch(symbol, fetchStartSec, fetchEndSec);
      if (candles.length > 0) {
        candlesBySymbol.set(normalizeSymbolCase(symbol), candles);
      } else {
        logger.warn(`[BacktestEngine] ${symbol} 在指定时间范围内无 K 线数据，跳过`);
      }
    }
    if (candlesBySymbol.size === 0) {
      throw new Error('所有品种均无 K 线数据，无法回测');
    }

    // ── 4. 价格钩子：marketService.getCurrentPrice → 回放 K 线收盘价 ──
    setBacktestPriceProvider(symbol => {
      const candles = candlesBySymbol.get(normalizeSymbolCase(symbol));
      if (!candles) return null;
      const price = priceAtTime(candles, simTimeMs() ?? Date.now());
      return price;
    });

    // ── 5. 虚拟交易所：建立行情订阅并拿到实例引用 ──
    const exchange = exchangeRegistry.getExchange(this.cfg.runKey) as VirtualGateExchange;
    const hub = exchangeRegistry.getVirtualTradFiHub();
    for (const symbol of candlesBySymbol.keys()) {
      // getTicker 触发 subscribeSymbol，使后续注入的 tick 能驱动撮合
      await exchange.getTicker(symbol);
    }

    // ── 6. 逐 K 线重放 ──
    const replayStat = await this.replay(normalized.messages, candlesBySymbol, hub, exchange, rangeStartMs - LOOKBACK_MS, rangeEndMs);

    // ── 7. 导出结果 ──
    setSimTime(rangeEndMs);
    this.writeProgress({ phase: 'exporting' });
    const result = await this.exportResults(rangeStartMs - LOOKBACK_MS, rangeEndMs, replayStat);
    this.writeProgress({
      phase: this.stopRequested ? 'stopped' : 'done',
      messagesProcessed: this.messagesProcessed,
      messagesTotal: this.messagesTotal,
      candlesTotal: replayStat.totalMinutes,
      candlesDone: replayStat.minutesDone,
      simTime: new Date(rangeEndMs).toISOString(),
    });
    logger.info(`[BacktestEngine] 回测结束: 已成交 ${result.summary.filledOrders} 单, 已平仓 ${result.summary.closedOrders} 单, 已实现盈亏 ${result.summary.realizedPnl}, 最终权益 ${result.summary.finalEquity}`);
  }

  // ─────────────────────────── 预解析 ───────────────────────────

  /**
   * 用路由配置的解析器预扫描全部消息，收集信号品种。
   * 仅处理与路由 channelId 匹配的消息（与运行时路由匹配逻辑一致）；
   * 解析失败的单条消息跳过，不影响整体。
   */
  private async collectSymbols(messages: NormalizedMessage[]): Promise<string[]> {
    const parser = strategyParserRegistry.getParserByName(this.cfg.parserName);
    if (!parser) {
      throw new Error(`解析器 ${this.cfg.parserName} 不存在`);
    }
    const channelId = String(this.cfg.route.channelId ?? '');
    const routeIds = [Number(this.cfg.route.id)].filter(Number.isFinite);
    const routeNames = [String(this.cfg.route.name ?? '')].filter(Boolean);
    const symbols = new Set<string>();
    let processed = 0;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.channel_id !== channelId) continue;
      try {
        const strategies = await aiParserService.runWithRouteContext(
          { routeIds, routeNames },
          () => parser.parse(buildDiscordMessage(message, i)),
        );
        for (const parsed of strategies || []) {
          const symbol = normalizeRouteSymbol(parsed?.symbol);
          if (symbol) symbols.add(symbol);
        }
      } catch (err: any) {
        logger.warn('[BacktestEngine] 预解析失败（跳过）', formatError(err));
      }
      if (++processed % 50 === 0) {
        this.writeProgress({ phase: 'preParse', messagesProcessed: processed, messagesTotal: this.messagesTotal });
      }
    }
    return Array.from(symbols);
  }

  // ─────────────────────────── 重放主循环 ───────────────────────────

  private async replay(
    messages: NormalizedMessage[],
    candlesBySymbol: Map<string, BacktestCandle[]>,
    hub: import('../services/marketData/MarketDataHub').MarketDataHub,
    exchange: VirtualGateExchange,
    replayStartMs: number,
    replayEndMs: number,
  ): Promise<{ minutesDone: number; totalMinutes: number }> {
    // 品种 → 分钟 K 线索引
    const candleMaps = new Map<string, Map<number, BacktestCandle>>();
    for (const [symbol, candles] of candlesBySymbol) {
      candleMaps.set(symbol, new Map(candles.map(c => [c.ts, c])));
    }

    // 消息按分钟分桶（保留原始顺序）
    const messagesByMinute = new Map<number, Array<{ index: number; message: NormalizedMessage }>>();
    for (let i = 0; i < messages.length; i++) {
      const ts = new Date(messages[i].timestamp).getTime();
      const minute = Math.floor(ts / 60_000) * 60;
      let bucket = messagesByMinute.get(minute);
      if (!bucket) {
        bucket = [];
        messagesByMinute.set(minute, bucket);
      }
      bucket.push({ index: i, message: messages[i] });
    }

    const startSec = Math.floor(replayStartMs / 60_000) * 60;
    const endSec = Math.ceil(replayEndMs / 60_000) * 60;
    const totalMinutes = Math.max(1, Math.floor((endSec - startSec) / 60) + 1);
    let minutesDone = 0;

    for (let minuteSec = startSec; minuteSec <= endSec; minuteSec += 60) {
      if (this.stopRequested) {
        logger.info('[BacktestEngine] 收到停止请求，结束重放');
        break;
      }

      const minuteMessages = messagesByMinute.get(minuteSec) ?? [];
      const minuteCandles: Array<{ symbol: string; candle: BacktestCandle }> = [];
      for (const [symbol, cmap] of candleMaps) {
        const candle = cmap.get(minuteSec);
        if (candle) minuteCandles.push({ symbol, candle });
      }

      // 空分钟（无 K 线也无消息）直接跳过，不产生任何副作用
      if (minuteCandles.length === 0 && minuteMessages.length === 0) {
        minutesDone++;
        continue;
      }

      // 每个 tick 槽位注入的 {symbol, price}
      const tickSlots: Array<Array<{ symbol: string; price: number }>> = [[], [], [], []];
      for (const { symbol, candle } of minuteCandles) {
        const ticks = candleToTicks(candle);
        for (let k = 0; k < 4 && k < ticks.length; k++) {
          tickSlots[k].push({ symbol, price: ticks[k].price });
        }
      }

      // 消息按其秒级时间归入 tick 槽位：slot k 覆盖 [slotTime_k, slotTime_{k+1})
      const slotTimes = TICK_SLOT_OFFSETS_MS.map(offset => minuteSec * 1000 + offset);
      const slotMessages: Array<Array<{ index: number; message: NormalizedMessage }>> = [[], [], [], []];
      for (const entry of minuteMessages) {
        const ts = new Date(entry.message.timestamp).getTime();
        let slot = slotTimes.length - 1;
        for (let k = slotTimes.length - 1; k >= 0; k--) {
          if (ts >= slotTimes[k]) { slot = k; break; }
        }
        slotMessages[slot].push(entry);
      }

      for (let k = 0; k < 4; k++) {
        // 注入该槽位的全部品种 tick
        if (tickSlots[k].length > 0) {
          const tickTime = slotTimes[k];
          setSimTime(tickTime);
          for (const { symbol, price } of tickSlots[k]) {
            hub.ingestTick({
              symbol,
              lastPrice: String(price),
              markPrice: String(price),
              indexPrice: String(price),
              source: 'gate',
              receivedAt: new Date(tickTime),
            });
          }
          await this.settle(exchange);
        }

        // 派发该槽位内的消息（原始信号时间）
        for (const { index, message } of slotMessages[k]) {
          setSimTime(new Date(message.timestamp).getTime());
          try {
            await handleChannelMessage(buildDiscordMessage(message, index));
          } catch (err) {
            logger.error('[BacktestEngine] 消息处理失败（继续）', formatError(err));
          }
          this.messagesProcessed++;
          await this.settle(exchange);
        }
      }

      minutesDone++;
      this.writeProgress({
        phase: 'replaying',
        candlesDone: minutesDone,
        candlesTotal: totalMinutes,
        messagesProcessed: this.messagesProcessed,
        messagesTotal: this.messagesTotal,
        simTime: new Date(minuteSec * 1000).toISOString(),
      }, /* force */ false);
    }

    // 尾部排空（最后一批消息触发的挂单/保护单链路）
    await this.settle(exchange);
    await this.settle(exchange);
    this.writeProgress({
      phase: 'replaying',
      candlesDone: minutesDone,
      candlesTotal: totalMinutes,
      messagesProcessed: this.messagesProcessed,
      messagesTotal: this.messagesTotal,
      simTime: new Date(replayEndMs).toISOString(),
    });
    return { minutesDone, totalMinutes };
  }

  /**
   * 等待撮合与消息管线全部落地：
   * - drainTicks 等待 per-symbol tick 处理队列（含级联撮合/回调）；
   * - setImmediate 让 waitForOrderFill 的 .then 链（挂单成交后的 post-fill
   *   保护单放置）有机会执行，再排空一轮。
   */
  private async settle(exchange: VirtualGateExchange): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await exchange.drainTicks();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await exchange.drainTicks();
  }

  // ─────────────────────────── 进度 ───────────────────────────

  private writeProgress(progress: Omit<BacktestProgress, 'updatedAt'>, force = true): void {
    const now = Date.now();
    if (!force && now - this.lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
    this.lastProgressWriteAt = now;
    const payload: BacktestProgress = { ...progress, updatedAt: new Date(now).toISOString() };
    try {
      const tmp = `${this.cfg.progressPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.cfg.progressPath);
    } catch (err) {
      logger.warn('[BacktestEngine] 写进度文件失败', formatError(err));
    }
  }

  // ─────────────────────────── 结果导出 ───────────────────────────

  private async exportResults(simStartMs: number, simEndMs: number, replayStat: { minutesDone: number; totalMinutes: number }): Promise<any> {
    const runKey = this.cfg.runKey;
    const [strategies, orders, virtualOrders, virtualTrades, virtualPositions, virtualAccounts, auditLogs, aiLogs, strategyPositions, softStopLosses] = await Promise.all([
      Strategy.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      Order.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      VirtualOrder.findAll({ where: { exchangeInstanceId: runKey }, order: [['createdAt', 'ASC']] }),
      VirtualTrade.findAll({ where: { exchangeInstanceId: runKey }, order: [['executedAt', 'ASC'], ['id', 'ASC']] }),
      VirtualPosition.findAll({ where: { exchangeInstanceId: runKey } }),
      VirtualAccount.findAll({ where: { exchangeInstanceId: runKey } }),
      AuditLog.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      AILog.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      StrategyPosition.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      SoftStopLoss.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
    ]);

    const summary = this.buildSummary(strategies, orders, virtualOrders, virtualTrades, virtualPositions, virtualAccounts, simStartMs, simEndMs, replayStat);
    const result = {
      runKey,
      runId: this.cfg.runId,
      stopped: this.stopRequested,
      finishedAt: new Date().toISOString(),
      simStartTime: new Date(simStartMs).toISOString(),
      simEndTime: new Date(simEndMs).toISOString(),
      initialBalance: Number(this.cfg.initialBalance),
      summary,
      strategies: strategies.map(row => row.toJSON()),
      orders: orders.map(row => row.toJSON()),
      virtualOrders: virtualOrders.map(row => row.toJSON()),
      virtualTrades: virtualTrades.map(row => row.toJSON()),
      virtualPositions: virtualPositions.map(row => row.toJSON()),
      virtualAccounts: virtualAccounts.map(row => row.toJSON()),
      auditLogs: auditLogs.map(row => row.toJSON()),
      // 解析记录（AI 调用明细）：剥离 imageBase64 大字段，其余如实导出
      aiLogs: aiLogs.map(row => {
        const data = row.toJSON();
        if (data.imageBase64) data.imageBase64 = '<omitted:backtest-export>';
        return data;
      }),
      strategyPositions: strategyPositions.map(row => row.toJSON()),
      softStopLosses: softStopLosses.map(row => row.toJSON()),
    };

    fs.mkdirSync(path.dirname(this.cfg.resultPath), { recursive: true });
    fs.writeFileSync(this.cfg.resultPath, JSON.stringify(result));
    logger.info(`[BacktestEngine] 结果已导出: ${this.cfg.resultPath}`);
    return result;
  }

  /** 汇总统计：权益曲线 / 最大回撤 / 胜率 / 品种与月度分布 */
  private buildSummary(
    strategies: any[],
    orders: any[],
    virtualOrders: any[],
    virtualTrades: any[],
    virtualPositions: any[],
    virtualAccounts: any[],
    simStartMs: number,
    simEndMs: number,
    replayStat: { minutesDone: number; totalMinutes: number },
  ): any {
    const initial = Number(this.cfg.initialBalance) || 0;
    const account = virtualAccounts.find(a => a.currency === 'USDT');
    const realizedPnl = Number(account?.realizedPnl || '0');
    const available = Number(account?.availableBalance || '0');

    // 未实现盈亏：按持仓 markPrice（最后一根 tick 价）估算
    let unrealizedPnl = 0;
    for (const position of virtualPositions) {
      const size = Number(position.size || '0');
      if (!Number.isFinite(size) || size === 0) continue;
      const entry = Number(position.entryPrice || '0');
      const mark = Number(position.markPrice || '0');
      if (!Number.isFinite(entry) || !Number.isFinite(mark)) continue;
      unrealizedPnl += (mark - entry) * size;
    }
    const finalEquity = available + unrealizedPnl;

    // 权益曲线（含期初点），只累计有已实现盈亏的成交
    const equityPoints: Array<{ t: string; equity: number }> = [{ t: new Date(simStartMs).toISOString(), equity: initial }];
    let cumulative = initial;
    for (const trade of virtualTrades) {
      const pnl = Number(trade.realizedPnl || '0');
      if (!Number.isFinite(pnl) || pnl === 0) continue;
      cumulative += pnl;
      equityPoints.push({ t: (trade.executedAt instanceof Date ? trade.executedAt : new Date(trade.executedAt)).toISOString(), equity: cumulative });
    }

    // 最大回撤
    let peak = initial;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    for (const point of equityPoints) {
      peak = Math.max(peak, point.equity);
      const drawdown = peak - point.equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
      }
    }

    // 平仓成交（sl/tp/close 角色或有已实现盈亏）胜负统计
    const isClosingTrade = (t: any) => ['sl', 'tp', 'close'].includes(String(t.text || '').split('-')[1]) || Number(t.realizedPnl || '0') !== 0;
    const closingTrades = virtualTrades.filter(isClosingTrade);
    const wins = closingTrades.filter(t => Number(t.realizedPnl || '0') > 0).length;
    const losses = closingTrades.filter(t => Number(t.realizedPnl || '0') < 0).length;

    // 品种 / 月度分布
    const bySymbol = new Map<string, { trades: number; realizedPnl: number }>();
    const byMonth = new Map<string, { trades: number; realizedPnl: number }>();
    for (const trade of virtualTrades) {
      const pnl = Number(trade.realizedPnl || '0');
      const symbolEntry = bySymbol.get(trade.symbol) || { trades: 0, realizedPnl: 0 };
      symbolEntry.trades++;
      symbolEntry.realizedPnl += pnl;
      bySymbol.set(trade.symbol, symbolEntry);

      const executedAt = trade.executedAt instanceof Date ? trade.executedAt : new Date(trade.executedAt);
      const month = `${executedAt.getUTCFullYear()}-${String(executedAt.getUTCMonth() + 1).padStart(2, '0')}`;
      const monthEntry = byMonth.get(month) || { trades: 0, realizedPnl: 0 };
      monthEntry.trades++;
      monthEntry.realizedPnl += pnl;
      byMonth.set(month, monthEntry);
    }

    return {
      initialBalance: initial,
      realizedPnl,
      unrealizedPnl,
      finalEquity,
      availableBalance: available,
      totalStrategies: strategies.length,
      totalOrders: orders.length,
      filledOrders: virtualOrders.filter(o => o.status === 'filled').length,
      cancelledOrders: virtualOrders.filter(o => o.status === 'cancelled').length,
      pendingOrders: virtualOrders.filter(o => o.status === 'open').length,
      closedOrders: orders.filter(o => o.lifecycleStatus === 'CLOSED').length,
      totalTrades: virtualTrades.length,
      closingTrades: closingTrades.length,
      wins,
      losses,
      winRate: closingTrades.length > 0 ? (wins / closingTrades.length) * 100 : 0,
      maxDrawdown,
      maxDrawdownPct,
      equityCurve: equityPoints,
      bySymbol: Object.fromEntries(bySymbol),
      byMonth: Object.fromEntries(byMonth),
      replayMinutes: replayStat.minutesDone,
      totalReplayMinutes: replayStat.totalMinutes,
      simStart: new Date(simStartMs).toISOString(),
      simEnd: new Date(simEndMs).toISOString(),
      stopped: this.stopRequested,
    };
  }
}
