/**
 * Gate-CFD（/tradfi/*）交易所适配器 —— 独立实现 IExchange（不继承 GateIOExchange）。
 *
 * 与加密合约（GateIOExchange）的本质差异（设计文档 内部设计文档 §2.1）：
 * 1. CFD 是「一单一仓」的独立持仓实体（positionId），TP/SL 是仓位属性而非独立挂单，
 *    一个仓位只能有一个 TP 价 + 一个 SL 价（MT5 模型）；
 * 2. 无【私有】WebSocket 通道（现货 WS v3 / 合约 WS v4 均无 tradfi.* 私有频道），
 *    成交确认与持仓同步只能靠 REST 轮询（CfdOrderPoller / CfdPositionPoller）；
 *    仅存在【公共】tradfi WS 行情频道（tradfi.tickers），由 GateTradFiMarketDataStream 消费。
 * 3. 固定杠杆（API 不可调）、固定交易时段（周末休市）、隔夜费、强平线。
 *
 * 多 TP = 多仓分腿（需求方确认的方案 D1）：N 个 TP 档 → N 个独立仓位，
 * 每腿下单自带相同 SL + 各自 TP，全部由交易所托管；任一腿失败 → 全回滚。
 */
import { EventEmitter } from 'events';
import {
  IExchange, OrderParams, OrderResult, AccountBalance, Position, MarketInfo,
  Ticker, Candle, Trade, ExchangeConfig,
} from './IExchange';
import { GateCFDRestClient } from './gate_cfd/GateCFDRestClient';
import { GateCFDSymbolUtils } from './gate_cfd/GateCFDSymbolUtils';
import { GateCFDMapper } from './gate_cfd/GateCFDMapper';
import { CfdLegPlanner } from './gate_cfd/CfdLegPlanner';
import { CfdOrderPoller } from './gate_cfd/CfdOrderPoller';
import { CfdPositionPoller } from './gate_cfd/CfdPositionPoller';
import { CfdPersistenceHandler } from './gate_cfd/CfdPersistenceHandler';
import { CfdSessionGuard } from './gate_cfd/CfdSessionGuard';
import { CfdLeg, CfdOrderRow } from './gate_cfd/types';
import { GateTradFiMarketDataStream } from '../marketData/GateTradFiMarketDataStream';
import logger, { formatError } from '../../utils/logger';
import config from '../../config';

/** CFD 平仓类型（SDK TradFiClosePositionRequest.CloseType 枚举）：
 *  NOTE：数值语义需在 P0 验证（V2）时用真实 key 实测确认——
 *  当前按 MT5 惯例假设：1 = 按手数部分平仓（需 closeVolume），2 = 全部平仓。
 */
const CLOSE_PARTIAL = 1;
const CLOSE_FULL = 2;

/**
 * CFD 方向映射：IExchange 'buy'/'sell' → SDK Side。
 * 【2026-08-20 gate-tradfi-test 实盘实测纠正】：
 *   side=1 创建的是 Short（空）仓位，side=2 创建的是 Long（多）仓位。
 *   原映射 { buy:1, sell:2 } 是反的——会导致"买入信号开空仓"。
 *   正确映射：buy→2（Long），sell→1（Short）。
 */
const SIDE_TO_SDK: Record<string, number> = { buy: 2, sell: 1 };

export class GateCFDExchange extends EventEmitter implements IExchange {
  id: string;
  name: string;
  /** 能力标记，供上层以 isGateCfdExchange 分支（替代 isLighterExchange 式的构造器名判断） */
  public readonly productLine = 'gate_cfd' as const;

  /** 正在开仓的品种集合（对齐 GateIOExchange.pendingOpenSymbols 语义） */
  public readonly pendingOpenSymbols = new Set<string>();

  private readonly restClient: GateCFDRestClient;
  private readonly symbolUtils: GateCFDSymbolUtils;
  private readonly orderPoller: CfdOrderPoller;
  private readonly positionPoller: CfdPositionPoller;
  private readonly persistenceHandler: CfdPersistenceHandler;
  private readonly sessionGuard = new CfdSessionGuard();

  /** WS/HTTP 代理（实例配置 > 全局 apiProxy，与 GateCFDRestClient 优先级一致） */
  private readonly proxyUrl: string | undefined;

  /** 我们跟踪的持仓 positionId 集合（多腿 = 多个 positionId），供 foreign_position 判定 */
  private trackedPositionIds = new Set<number | string>();
  private started = false;

  constructor(exchangeConfig: ExchangeConfig) {
    super();
    this.id = exchangeConfig.id;
    this.name = exchangeConfig.name || 'Gate-CFD';
    // 代理：兼容 proxy / proxyUrl 两种命名（UI 保存过两种格式），再回退到全局 apiProxy
    this.proxyUrl = exchangeConfig.proxy || (exchangeConfig as any).proxyUrl || config.trading.apiProxy;
    this.restClient = new GateCFDRestClient(exchangeConfig);
    this.symbolUtils = new GateCFDSymbolUtils(this.restClient);
    this.orderPoller = new CfdOrderPoller(this.restClient);
    this.positionPoller = new CfdPositionPoller(this.restClient);
    this.persistenceHandler = new CfdPersistenceHandler({
      onAudit: (action, details) => {
        // 适配器不直接依赖审计服务；由上层接线（见 OpenPositionService 集成）按需消费。
        logger.info(`CFD audit event: ${action}`, { details });
      },
    });
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 持仓事件 → 持久化状态机（Order/CfdLeg 生命周期）
    this.positionPoller.onPositionEvent = (event) => {
      this.persistenceHandler.handlePositionEvent(event).catch((err) => {
        logger.error('CfdPersistenceHandler.handlePositionEvent failed', formatError(err));
      });
    };
    this.orderPoller.start();
    this.positionPoller.start();
    // 启动对账：修复重启期间错过的状态迁移（设计 §4.4）
    try {
      await this.persistenceHandler.reconcileOnStartup(this.restClient, this.trackedPositionIds);
    } catch (err) {
      logger.error('CFD startup reconciliation failed', formatError(err));
    }
    logger.info(`GateCFDExchange started: ${this.id}`);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.orderPoller.stop();
    this.positionPoller.stop();
  }

  // -------------------------------------------------------------------------
  // 下单（含多腿）
  // -------------------------------------------------------------------------
  /**
   * CFD 下单：
   * - 单腿：params.cfdLegs 为空时按「单腿（amount + takeProfit/stopLoss）」处理；
   * - 多腿（多 TP 分腿）：params.cfdLegs 提供每腿 { legIndex, volume, tpPrice, priceSl }，
   *   逐腿 POST /tradfi/orders，每腿自带 priceTp/priceSl，全部交易所托管；
   * - 任一腿失败 → 全回滚（已成交市价腿按持仓平仓、在途 Trigger 腿撤单）并抛错，
   *   由上层（OpenPositionService）审计 CFD_LEG_ROLLBACK。
   */
  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const symbol = params.symbol;
    const side = SIDE_TO_SDK[params.side] ?? 1;

    // 1. 交易时段校验（CFD 固定时段，周末休市；休市拒单）
    try {
      const ticker = await this.restClient.querySymbolTicker(symbol);
      if (ticker) {
        const session = this.sessionGuard.checkCanTrade(ticker);
        if (!session.ok) {
          const err: any = new Error(`Market closed for ${symbol}: ${session.reason}`);
          err.label = 'MARKET_CLOSED';
          throw err;
        }
      }
    } catch (err: any) {
      if (err.label === 'MARKET_CLOSED') throw err;
      // ticker 拉取失败不阻断下单（兜底：允许继续，风险由交易所侧保护承担）
      logger.warn(`Failed to check CFD session for ${symbol}`, formatError(err));
    }

    // 2. 组装腿（缺省单腿）
    const legs: Array<{
      legIndex: number;
      volume: string;
      price?: string;
      priceType: 'Market' | 'Trigger';
      priceTp?: string;
      priceSl?: string;
    }> = [];
    const cfdLegs: CfdLeg[] | undefined = (params as any).cfdLegs;
    if (cfdLegs && cfdLegs.length > 0) {
      for (const leg of cfdLegs) {
        legs.push({
          legIndex: leg.legIndex,
          volume: leg.volume,
          priceType: params.type === 'limit' ? 'Trigger' : 'Market',
          price: params.price,
          priceTp: leg.tpPrice || undefined,
          priceSl: leg.priceSl || params.stopLoss,
        });
      }
    } else {
      // 单腿：复用现有 OrderParams 语义（amount + takeProfit/stopLoss）
      legs.push({
        legIndex: 0,
        volume: params.amount,
        priceType: params.type === 'limit' ? 'Trigger' : 'Market',
        price: params.price,
        priceTp: params.takeProfit,
        priceSl: params.stopLoss,
      });
    }

    // 3. 逐腿下单（任一腿失败 → 全回滚）
    //    【关键】市价单 body 不带 priceTp/priceSl：Gate TradFi 实测，市价单带 TP/SL 会被
    //    引擎静默拒单（state=0 / orderId=0），TP/SL 必须建仓后由 updatePosition 设置。
    //    Trigger（限价）腿则相反：body 必须带 priceTp/priceSl —— API 实测接受，且
    //    成交后随单托管进持仓（防止「限价单未成交 → 步骤 5 等待超时 → TP/SL 永久丢失」）。
    const legResults: Array<{ legIndex: number; orderId: number | string; status: string; logId?: string | number }> = [];
    const placedOrders: Array<{ orderId: number | string; logId?: string | number; volume: string; priceType: 'Market' | 'Trigger' }> = [];
    const legTpSl: Array<{ legIndex: number; logId?: string | number; priceTp?: string; priceSl?: string }> = [];
    let legGroupId: string | undefined = (params as any).legGroupId;
    try {
      for (const leg of legs) {
        const body: any = {
          symbol,
          side,
          priceType: leg.priceType,
          volume: leg.volume,
          price: leg.priceType === 'Market' ? '0' : (leg.price || '0'),
          // 市价腿：不带 priceTp/priceSl（见上方注释）；Trigger 腿：随单携带 TP/SL（有值才带）
          ...(leg.priceType === 'Trigger' && (leg.priceTp || leg.priceSl)
            ? {
                ...(leg.priceTp ? { priceTp: leg.priceTp } : {}),
                ...(leg.priceSl ? { priceSl: leg.priceSl } : {}),
              }
            : {}),
        };
        logger.info(`CFD placing leg ${leg.legIndex} for ${symbol}`, { body });
        const res = await this.restClient.createOrder(body);
        const orderId = res?.id;
        if (orderId === undefined || orderId === null) {
          throw new Error(`CFD createOrder returned no id for leg ${leg.legIndex}`);
        }
        placedOrders.push({ orderId, logId: res.logId, volume: leg.volume, priceType: leg.priceType });
        legResults.push({ legIndex: leg.legIndex, orderId, status: 'submitted', logId: res.logId });
        legTpSl.push({ legIndex: leg.legIndex, logId: res.logId, priceTp: leg.priceTp, priceSl: leg.priceSl });
      }
    } catch (err) {
      // 4. 全回滚（best-effort）：已成交市价腿平仓 + 在途 Trigger 腿撤单
      await this.rollbackPlacedLegs(symbol, placedOrders);
      const rollbackErr: any = err instanceof Error ? err : new Error(String(err));
      rollbackErr.rollback = { placedCount: placedOrders.length, rolledBack: true };
      throw rollbackErr;
    }

    // 5. 建仓后设置 TP/SL（仅市价腿：Trigger 腿保护已随单携带进订单，成交后由交易所托管，
    //    不在此等待成交——限价单可能长时间未成交，waitForFilledPositionId 会超时导致 TP/SL 丢失）
    //    Gate TradFi 实测：orderId === positionId；通过 queryOrderLog(logId) 取 orderId 即 positionId。
    for (const leg of legTpSl) {
      if ((!leg.priceTp && !leg.priceSl) || !leg.logId) continue;
      const legMeta = placedOrders.find((o) => o.logId === leg.logId);
      if (legMeta?.priceType === 'Trigger') continue; // Trigger 腿：保护随单携带，无需补设
      try {
        const positionId = await this.waitForFilledPositionId(leg.logId);
        if (positionId != null) {
          await this.restClient.updatePosition(positionId, { priceTp: leg.priceTp, priceSl: leg.priceSl });
          logger.info(`CFD leg ${leg.legIndex}: TP/SL set on position ${positionId}`);
        } else {
          logger.warn(`CFD leg ${leg.legIndex}: position not found for TP/SL (logId=${leg.logId})`);
        }
      } catch (e) {
        logger.error(`CFD leg ${leg.legIndex}: failed to set TP/SL`, formatError(e));
      }
    }

    // 6. 回写跟踪集合：市价单大概率已成交，尝试把仓位 positionId 纳入跟踪
    await this.syncTrackedPositions(symbol).catch((e) =>
      logger.warn(`Failed to sync tracked positions after open for ${symbol}`, formatError(e)));

    return {
      id: String(legResults[0]?.orderId ?? ''),
      status: 'submitted',
      symbol,
      side: params.side,
      amount: params.amount,
      price: params.price,
      legs: legResults,
      legGroupId,
      cfd: true,
    };
  }

  /**
   * 轮询订单日志直到成交，返回 positionId（= orderId，实盘实测等价）。
   * 超时（默认 15s）返回 null。仅用于市价腿建仓后定位 positionId 以设置 TP/SL。
   */
  private async waitForFilledPositionId(logId: string | number, timeoutMs = 15000): Promise<string | number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const log: any = await this.restClient.queryOrderLog(logId);
        if (log && log.state === 4 && log.orderId) {
          return log.orderId;
        }
      } catch (e) {
        logger.warn(`CFD waitForFilledPositionId log query failed for ${logId}`, formatError(e));
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  /** 多腿回滚：已提交的腿中，Market 腿按持仓平仓、Trigger 腿撤单（均 best-effort） */
  private async rollbackPlacedLegs(symbol: string, placed: Array<{ orderId: number | string; volume: string; priceType: 'Market' | 'Trigger' }>): Promise<void> {
    const marketLegs = placed.filter((l) => l.priceType === 'Market');
    const triggerLegs = placed.filter((l) => l.priceType === 'Trigger');
    // 市价腿：查持仓按 symbol+volume 匹配平仓
    if (marketLegs.length > 0) {
      try {
        const positions = await this.restClient.queryPositionList();
        const matches = positions.filter((p) => p.symbol === symbol);
        for (const leg of marketLegs) {
          const match = matches.find((p) =>
            p.positionId != null && Math.abs(parseFloat(p.volume ?? '0') - parseFloat(leg.volume)) < 1e-6);
          if (match) {
            try {
              await this.restClient.closePosition(match.positionId, { closeType: CLOSE_FULL });
              logger.warn(`CFD rollback: closed position ${match.positionId} (leg ${leg.volume})`);
            } catch (e) {
              logger.error(`CFD rollback: failed to close position ${match.positionId}`, formatError(e));
            }
          } else {
            logger.warn(`CFD rollback: no matching position found for ${symbol} volume=${leg.volume}`);
          }
        }
      } catch (e) {
        logger.error(`CFD rollback: failed to list positions for ${symbol}`, formatError(e));
      }
    }
    // Trigger 腿：直接撤单
    for (const leg of triggerLegs) {
      try {
        await this.restClient.cancelOrder(leg.orderId);
        logger.warn(`CFD rollback: cancelled trigger order ${leg.orderId}`);
      } catch (e) {
        logger.error(`CFD rollback: failed to cancel order ${leg.orderId}`, formatError(e));
      }
    }
  }

  /** 把 symbol 下与已开腿匹配的仓位 positionId 纳入跟踪集合（供 foreign_position 判定） */
  private async syncTrackedPositions(symbol: string): Promise<void> {
    const positions = await this.restClient.queryPositionList();
    for (const p of positions) {
      if (p.symbol === symbol && p.positionId != null) {
        this.trackedPositionIds.add(p.positionId);
      }
    }
    this.positionPoller.setTrackedPositionIds(this.trackedPositionIds);
  }

  // -------------------------------------------------------------------------
  // 订单操作
  // -------------------------------------------------------------------------
  async amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult> {
    const body: any = {};
    if (price !== undefined) body.price = price;
    if (amount !== undefined) body.volume = amount;
    await this.restClient.updateOrder(orderId as any, body);
    return { id: orderId, status: 'updated', symbol };
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<boolean> {
    try {
      await this.restClient.cancelOrder(orderId as any);
      return true;
    } catch (err) {
      logger.error(`CFD cancelOrder failed for ${orderId}`, formatError(err));
      return false;
    }
  }

  async cancelPriceOrder(orderId: string, symbol: string): Promise<boolean> {
    // CFD 无独立价格触发单体系：Trigger 挂单（限价入场）即撤单语义
    return this.cancelOrder(orderId, symbol);
  }

  async getOrder(orderId: string, _symbol: string): Promise<OrderResult> {
    const list = await this.restClient.queryOrderList();
    const row = list.find((o) => String(o.orderId) === String(orderId));
    if (row) return this.toOrderResult(row);
    // 活动单没有 → 查历史
    const history = await this.restClient.queryOrderHistoryList();
    const hRow = history.find((o) => String(o.orderId) === String(orderId));
    if (hRow) return this.toOrderResult(hRow);
    return { id: orderId, status: 'unknown', symbol: _symbol };
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const list = await this.restClient.queryOrderList();
    const rows = symbol ? list.filter((o) => o.symbol === symbol) : list;
    return rows.map((o) => this.toOrderResult(o));
  }

  async getFinishedOrders(symbol: string, limit = 100): Promise<OrderResult[]> {
    const history = await this.restClient.queryOrderHistoryList({ symbol, limit });
    return (history || []).map((o) => this.toOrderResult(o));
  }

  async getPriceOrders(symbol?: string): Promise<OrderResult[]> {
    // Trigger 类型的挂单（限价入场单）
    const open = await this.getOpenOrders(symbol);
    return open.filter((o) => (o as any).priceType === 'Trigger');
  }

  private toOrderResult(row: CfdOrderRow): OrderResult {
    const normalized = GateCFDMapper.mapOrderRow(row);
    const finished = normalized.finished === true
      || /finish|cancel|filled|closed/i.test(normalized.stateDesc || '');
    return {
      id: String(normalized.orderId),
      status: finished ? 'finished' : 'open',
      symbol: normalized.symbol,
      side: normalized.side,
      price: normalized.price,
      amount: normalized.volume,
      priceType: normalized.priceType,
      priceTp: normalized.priceTp,
      priceSl: normalized.priceSl,
      raw: row.raw,
    };
  }

  // -------------------------------------------------------------------------
  // 平仓 / 改 SL / 改 TP（CFD 语义：操作对象是仓位 positionId，非独立挂单）
  // -------------------------------------------------------------------------
  async closePosition(symbol: string, side: 'buy' | 'sell', price?: string, amount?: string, text?: string): Promise<boolean> {
    const positions = await this.restClient.queryPositionList();
    const symbolPositions = positions.filter((p) => p.symbol === symbol && p.positionId != null);
    if (symbolPositions.length === 0) {
      logger.warn(`CFD closePosition: no positions for ${symbol}`);
      return false;
    }
    // 多腿 = 同 symbol 多个仓位：按 target volume 整腿贪心组合
    const targetVolume = amount !== undefined && amount !== null && parseFloat(amount) > 0
      ? parseFloat(amount)
      : null;
    let remaining = targetVolume;
    let closed = 0;
    for (const p of symbolPositions) {
      const vol = parseFloat(p.volume ?? '0');
      if (remaining === null) {
        // 全平：closeType=全部
        await this.restClient.closePosition(p.positionId, { closeType: CLOSE_FULL });
        closed++;
        continue;
      }
      if (remaining <= 0) break;
      if (vol <= remaining + 1e-9) {
        await this.restClient.closePosition(p.positionId, { closeType: CLOSE_FULL });
        remaining -= vol;
        closed++;
      } else {
        // 单腿部分平仓（closeVolume ≥ min 的约束由上层 CfdLegPlanner/调用方保证）
        await this.restClient.closePosition(p.positionId, { closeType: CLOSE_PARTIAL, closeVolume: String(remaining) });
        remaining = 0;
        closed++;
      }
    }
    logger.info(`CFD closePosition ${symbol} ${side} amount=${amount ?? 'all'}: closed ${closed} positions`);
    return closed > 0;
  }

  async updateStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text = 'sl-trigger-breakeven', amount?: string): Promise<string | null> {
    const positions = await this.restClient.queryPositionList();
    const symbolPositions = positions.filter((p) => p.symbol === symbol && p.positionId != null);
    let updated = 0;
    for (const p of symbolPositions) {
      await this.restClient.updatePosition(p.positionId, { priceSl: price });
      updated++;
    }
    if (updated === 0) return null;
    // 返回首个 positionId 作为锚点（与 IExchange.updateStopLoss 的 string 返回契约对齐）
    return String(symbolPositions[0].positionId);
  }

  /** 改 TP（CFD 无独立 TP 挂单：直接改仓位 priceTp）—— IExchange 接口外扩展方法 */
  async updateTakeProfit(symbol: string, side: 'buy' | 'sell', price: string, text?: string): Promise<string | null> {
    const positions = await this.restClient.queryPositionList();
    const symbolPositions = positions.filter((p) => p.symbol === symbol && p.positionId != null);
    let updated = 0;
    for (const p of symbolPositions) {
      await this.restClient.updatePosition(p.positionId, { priceTp: price });
      updated++;
    }
    return updated > 0 ? String(symbolPositions[0].positionId) : null;
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------
  async getBalance(_currency?: string): Promise<AccountBalance> {
    const assets = await this.restClient.queryUserAssets();
    if (!assets) return { currency: 'USDT', available: '0', total: '0' };
    return GateCFDMapper.toAccountBalance(assets);
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const positions = await this.getPositions();
    const found = positions.find((p) => p.symbol === symbol && parseFloat(p.size) !== 0);
    return found || null;
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.restClient.queryPositionList();
    return (rows || []).map((r) => GateCFDMapper.toPosition(r));
  }

  // -------------------------------------------------------------------------
  // 行情
  // -------------------------------------------------------------------------
  async getMarkets(): Promise<MarketInfo[]> {
    const specs = await this.symbolUtils.getSpecs();
    return (specs || []).map((s) => GateCFDMapper.toMarketInfo(s));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const raw = await this.restClient.querySymbolTicker(symbol);
    if (!raw) {
      throw new Error(`No CFD ticker for ${symbol}`);
    }
    return GateCFDMapper.mapTicker(raw, symbol);
  }

  async getCandles(symbol: string, timeframe: string, limit = 100): Promise<Candle[]> {
    if (!this.restClient.querySymbolKline) {
      throw new Error('CFD klines not supported');
    }
    const rows = await this.restClient.querySymbolKline(symbol, timeframe, limit);
    return (rows || []).map((r: any) => ({
      timestamp: r.timestamp ?? r.time ?? 0,
      open: String(r.open ?? r.o ?? ''),
      high: String(r.high ?? r.h ?? ''),
      low: String(r.low ?? r.l ?? ''),
      close: String(r.close ?? r.c ?? ''),
      volume: r.volume != null ? String(r.volume) : undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // 成交确认（替代 WS 回调：走 CfdOrderPoller 差异化轮询）
  // -------------------------------------------------------------------------
  async waitForOrderFill(orderId: string, symbol: string, timeoutMs = 60000): Promise<OrderResult> {
    // priceType：由调用方在 timeoutMs=0（限价无限等待）时默认 Trigger 语义；
    // 此处无额外上下文，交由 poller 按 timeout 参数与注册表自适应。
    const row = await this.orderPoller.waitForOrderFill(orderId, symbol, { timeoutMs });
    const result = this.toOrderResult(row);
    if (row.finished !== false && /finish|cancel/i.test(row.stateDesc || '')) {
      result.status = row.stateDesc?.toLowerCase() || 'finished';
    }
    return result;
  }

  async getTradeHistory(_symbol: string, _limit?: number): Promise<Trade[]> {
    // CFD 无标准 Trade 模型（无 maker/taker 角色概念，点差计价），返回空
    return [];
  }

  // -------------------------------------------------------------------------
  // 杠杆 / 保证金（CFD 固定杠杆，no-op）
  // -------------------------------------------------------------------------
  async setLeverage(_symbol: string, _leverage: string): Promise<boolean> { return true; }
  async setMarginMode(_symbol: string, _mode: 'cross' | 'isolated', _leverage?: string): Promise<boolean> { return true; }
  async getMarginMode(_symbol: string): Promise<{ marginMode: 'cross' | 'isolated'; leverage: string }> {
    return { marginMode: 'cross', leverage: '1' };
  }

  /**
   * Gate-CFD / TradFi 无私有 WebSocket 通道（仅公共行情 WS + REST 轮询）。
   * 用 started 状态表示"实例正常启动且轮询器运行中"，对齐 Dashboard 连接态展示语义。
   */
  getWebSocketStats() { return { isConnected: this.started }; }

  /**
   * 连接测试（对齐 GateIOExchange.testConnection 返回结构）。
   * - http：REST 探测（queryUserAssets 需 API key 鉴权，能真实验证凭据有效性）；
   * - ws：tradFi 公共行情 WS 探测（wss://fx-ws.gateio.ws/v4/ws/tradfi，
   *   连接并订阅 public tradfi.tickers；公共频道免鉴权）。
   * success = http 成功；ws 仅作附加信息，不阻断 success。
   */
  public async testConnection(): Promise<{ success: boolean; http: boolean; ws: boolean; message: string; details?: any }> {
      const result = {
          success: false,
          http: false,
          ws: false,
          message: '',
          details: {} as any,
      };
      try {
          const assets = await this.restClient.queryUserAssets();
          result.http = true;
          result.details = { equity: assets?.equity, mt5Uid: assets?.mt5Uid };
          result.success = true;
      } catch (e: any) {
          result.message = `HTTP Error: ${e?.message || String(e)}`;
          result.details.httpError = e?.message || String(e);
      }

      // WS 公共行情通道探测（独立于 REST，避免凭据异常掩盖 WS 状态）
      try {
          const wsProbe = await this.probeWebSocket();
          result.ws = wsProbe.ok;
          result.details = { ...(result.details || {}), ws: wsProbe.details };
      } catch (e: any) {
          result.ws = false;
          result.details = { ...(result.details || {}), wsError: e?.message || String(e) };
      }

      if (result.success) {
          result.message = `REST OK${result.ws ? '，WS 公共行情通道 OK' : '，WS 公共行情通道不可用'}`;
      }
      return result;
  }

  /**
   * 探测 tradFi 公共行情 WebSocket：短暂建立连接并订阅一个公共 ticker，
   * 连接成功即视为 WS 可用。探测用独立临时流，结束即销毁，不影响主行情单例。
   */
  private async probeWebSocket(timeoutMs = 8000): Promise<{ ok: boolean; details?: string }> {
      return new Promise((resolve) => {
          const stream = new GateTradFiMarketDataStream({
              proxyUrl: this.proxyUrl,
              reconnectDelayMs: 1000,
              maxReconnectDelayMs: 2000,
          });
          let settled = false;
          let poll: NodeJS.Timeout | null = null;
          let timer: NodeJS.Timeout | null = null;
          const finish = (ok: boolean, details: string) => {
              if (settled) return;
              settled = true;
              if (poll) clearInterval(poll);
              if (timer) clearTimeout(timer);
              stream.stop().catch(() => undefined);
              resolve({ ok, details });
          };
          timer = setTimeout(() => finish(false, `WS connect timeout (${timeoutMs}ms)`), timeoutMs);
          stream
              .start()
              .then(() => {
                  stream.subscribe('BTC_USDT');
                  poll = setInterval(() => {
                      if (stream.isConnected()) {
                          finish(true, 'connected & subscribed tradfi.tickers');
                      }
                  }, 200);
              })
              .catch((e: any) => {
                  finish(false, `WS start error: ${e?.message || String(e)}`);
              });
      });
  }
}
