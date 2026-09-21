import { Op } from 'sequelize';
import { Order, Strategy, SoftStopLoss } from '../models';
import exchangeRegistry from './exchanges';
import auditService from './AuditService';
import { buildTakeProfitOrderText } from '../utils/orderText';
import logger, { formatError, logContext } from '../utils/logger';
import orderPersistenceHandler from './OrderPersistenceHandler';
import { safeStringify } from '../utils/json';
import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';
import { OrderResult, OrderParams } from './exchanges/IExchange';
import { NoStopLossMonitor } from './NoStopLossMonitor';
import { ProtectionPipeline } from './ProtectionPipeline';
import { PostFillOrchestrator } from './PostFillOrchestrator';
import { ProtectionContext } from './ProtectionContext';
import { StartupRecoveryService } from './StartupRecoveryService';
import type { CloseExecutor } from './executor/types';
import tradingStatsService from './TradingStatsService';
import { createStageDebug } from '../utils/debug';
import config from '../config';
import { OpenPositionService } from './executor/OpenPositionService';
import { ClosePositionService } from './executor/ClosePositionService';
import { UpdateOrderService } from './executor/UpdateOrderService';
import { ExecutorServices, ExecutorCapabilities, summarizeParsedForDebug } from './executor/deps';

const debugOrder = createStageDebug('order');

/**
 * Optional constructor dependencies for TradeExecutor. When omitted, the
 * process-wide singletons are used, so `new TradeExecutor()` still behaves
 * as before (the default export relies on this).
 */
export interface TradeExecutorOptions {
  exchangeRegistry?: typeof exchangeRegistry;
  protectionContext?: ProtectionContext;
}

export class TradeExecutor {
  public noStopLossMonitor!: NoStopLossMonitor;
  public readonly protectionQtyEpsilon = 1e-8;
  private readonly lighterFillWaitTimeoutMs = 15000;
  private protectionContext: ProtectionContext;
  private startupRecoveryService!: StartupRecoveryService;

  private readonly services: ExecutorServices;
  private readonly closeService: ClosePositionService;
  private readonly openService: OpenPositionService;
  private readonly updateService: UpdateOrderService;

  constructor(options: TradeExecutorOptions = {}) {
      this.protectionContext = options.protectionContext ?? new ProtectionContext();
      const registry = options.exchangeRegistry ?? exchangeRegistry;
      this.services = {
          exchangeRegistry: registry,
          auditService,
          orderPersistenceHandler,
          tradingStatsService,
          protectionContext: this.protectionContext,
      };
      this.closeService = new ClosePositionService(this.services, this);
      this.openService = new OpenPositionService(this.services, this, this.closeService);
      this.updateService = new UpdateOrderService(this.services, this.closeService);
  }

  public getProtectionPipeline(exchangeInstanceId?: string): ProtectionPipeline {
      return this.protectionContext.getProtectionPipeline(exchangeInstanceId);
  }

  public async runWithStrategyTrace<T>(strategyId: number | undefined, fn: () => Promise<T>): Promise<T> {
      if (!strategyId) {
          return fn();
      }
      const traceId = `celue-${strategyId}`;
      return logContext.run(new Map([['traceId', traceId]]), fn);
  }

  public getFillWaitTimeout(exchange: any): number | undefined {
      return exchange?.constructor?.name === 'LighterExchange'
          ? this.lighterFillWaitTimeoutMs
          : undefined;
  }

  public createPostFillOrchestrator(exchange: any, noStopLossMonitor: NoStopLossMonitor, tradeExecutor: CloseExecutor): PostFillOrchestrator {
      return this.protectionContext.createPostFillOrchestrator(exchange, noStopLossMonitor, tradeExecutor);
  }

  public async persistSoftStopLossIfPresent(params: {
    strategyId?: number;
    orderId?: number;
    source: string;
    parserName?: string;
    exchangeInstanceId?: string;
    parsed: ParsedStrategy;
  }): Promise<void> {
    const softStop = (params.parsed.raw as any)?.neil?.softStop;
    if (!softStop) return;
    if (softStop.status !== 'active') return;
    if (!params.parsed.side || !['buy', 'sell'].includes(params.parsed.side)) return;
    if (!['15m', '1h', '4h', '12h', '1d'].includes(String(softStop.timeframe))) return;
    if (!['close_under', 'close_above'].includes(String(softStop.direction))) return;

    const price = Number(softStop.price);
    if (!Number.isFinite(price) || price <= 0) return;

    await SoftStopLoss.create({
      parserName: params.parserName || 'unknown',
      source: params.source,
      strategyId: params.strategyId || null,
      orderId: params.orderId || null,
      positionId: null,
      exchangeInstanceId: params.exchangeInstanceId || null,
      symbol: params.parsed.symbol,
      side: params.parsed.side,
      timeframe: softStop.timeframe,
      direction: softStop.direction,
      price: price.toString(),
      sourceText: softStop.sourceText || null,
      status: 'ACTIVE',
      raw: safeStringify((params.parsed.raw as any)?.neil || {}),
    });
  }

  public async initialize() {
      // 回测子进程：跳过实盘安全网监控（NoStopLossMonitor 基于真实时间扫描，
      // 与模拟时钟重放互扰；启动恢复在空库上也是无意义开销）。
      // 虚拟交易所的 TP/SL 由重放 tick 直接撮合，无需监控兜底。
      if (config.backtest.child) {
          logger.info('TradeExecutor: backtest child mode, skipping monitors and recovery');
          await this.wireProtectionPipelines();
          return;
      }

      logger.info('TradeExecutor: Initializing and recovering monitors...');
      this.noStopLossMonitor = new NoStopLossMonitor(this);
      this.noStopLossMonitor.start();
      this.startupRecoveryService = new StartupRecoveryService(this);
      await this.startupRecoveryService.recoverMonitors();
      await this.startupRecoveryService.recoverPositions();

      await this.wireProtectionPipelines();
  }

  /** 把 ProtectionPipeline 挂到所有支持它的交易所实例上 */
  private async wireProtectionPipelines(): Promise<void> {

      // Wire ProtectionPipeline into exchange persistence handlers
      const registry = this.services.exchangeRegistry;
      const entries = registry.getAllExchangeEntries
          ? registry.getAllExchangeEntries()
          : registry.getAllExchanges().map((exchange) => [exchange.id, exchange] as const);
      for (const [key, exchange] of entries) {
          if (exchange.setProtectionPipeline) {
              const pipeline = this.getProtectionPipeline(key);
              exchange.setProtectionPipeline(pipeline);
          }
          // P1-6: 任何暴露 EventEmitter 的交易所（Lighter / Gate）都在
          // WS 重连后对 PENDING 订单做 REST 对账，覆盖断线期间的成交。
          if (typeof exchange.on === 'function') {
              this.attachReconnectReconcile(key, exchange);
          }
      }
  }

  private attachReconnectReconcile(exchangeInstanceId: string, exchange: any): void {
      if (exchange.__tradeExecutorReconnectReconcileAttached) return;
      exchange.__tradeExecutorReconnectReconcileAttached = true;
      exchange.on('wsConnected', () => {
          this.startupRecoveryService.reconcilePendingOrders(exchangeInstanceId, exchange, 'ws-reconnect')
              .catch((err: any) => {
                  logger.warn(`TradeExecutor: reconnect REST reconcile failed for ${exchangeInstanceId}`, formatError(err));
              });
      });
  }

  public async executeAll(
    strategies: ParsedStrategy[],
    riskConfig: StrategyRiskConfig,
    source: string
  ): Promise<OrderResult[]> {
    const results: OrderResult[] = [];
    for (const strategy of strategies) {
      try {
        const result = await this.execute(strategy, riskConfig, source);
        if (result) results.push(result);
      } catch (error: any) {
        logger.error('Failed to execute strategy', formatError(error, { symbol: strategy.symbol, strategyId: (strategy as any).id }));
      }
    }
    return results;
  }

  public async execute(
    parsed: ParsedStrategy,
    riskConfig: StrategyRiskConfig,
    source: string,
    strategyId?: number,
    exchangeInstanceId?: string,
    routeId?: number
  ): Promise<OrderResult | null> {
    debugOrder('execute requested %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        source,
        parsed: summarizeParsedForDebug(parsed),
        riskConfig,
    });

    if (strategyId) {
        const auditSymbol = parsed.action === 'open' && typeof parsed.symbol === 'string'
            ? parsed.symbol.trim()
            : parsed.symbol;
        await auditService.log(strategyId, 'EXECUTING', {
            action: parsed.action,
            symbol: auditSymbol,
            effectiveRiskConfig: riskConfig,
            exchangeInstanceId
        }, undefined, undefined, exchangeInstanceId);
    }

    // Inject system-internal fields into parsed.raw so CloseScopeResolver
    // can use them for widening (routeId, source, parserName are not present
    // in the Discord message object that parsers put into parsed.raw).
    if (!parsed.raw) parsed.raw = {};
    if (routeId != null && parsed.raw.routeId == null) parsed.raw.routeId = routeId;
    if (source && !parsed.raw.source) parsed.raw.source = source;
    if (!parsed.raw.parserName && !parsed.raw.parser) {
      // Derive parserName from the strategy record if available
      const pName = (parsed as any).parserName;
      if (pName) parsed.raw.parserName = pName;
    }

    switch (parsed.action) {
      case 'open':
        debugOrder('dispatching open action %o', { strategyId, routeId, exchangeInstanceId, symbol: parsed.symbol });
        return this.handleOpen(parsed, riskConfig, source, strategyId, exchangeInstanceId, routeId);
      case 'close':
        debugOrder('dispatching close action %o', { strategyId, routeId, exchangeInstanceId, symbol: parsed.symbol });
        return this.handleClose(parsed, source, riskConfig, strategyId, undefined, exchangeInstanceId);
      case 'cancel':
        debugOrder('dispatching cancel action %o', { strategyId, routeId, exchangeInstanceId, symbol: parsed.symbol, orderId: parsed.orderId });
        return this.handleCancel(parsed, strategyId, exchangeInstanceId, routeId);
      case 'update':
        debugOrder('dispatching update action %o', { strategyId, routeId, exchangeInstanceId, symbol: parsed.symbol });
        return this.handleUpdate(parsed, strategyId, exchangeInstanceId, source, riskConfig);
      default:
        logger.warn(`Unknown strategy action: ${parsed.action}`);
        debugOrder('unknown action skipped %o', { strategyId, routeId, action: parsed.action });
        return null;
    }
  }

  public async closeForSoftStop(params: {
    symbol: string;
    side: 'buy' | 'sell';
    strategyId?: number;
    exchangeInstanceId?: string;
    source: string;
    riskConfig?: StrategyRiskConfig;
  }): Promise<OrderResult | null> {
    const parsed: ParsedStrategy = {
      action: 'close',
      symbol: params.symbol,
      side: params.side,
      closePercentage: 100,
      raw: {
        reason: 'soft_stop_loss_triggered',
        source: params.source,
      },
    };
    return this.handleClose(parsed, params.source, params.riskConfig, params.strategyId, params.side, params.exchangeInstanceId);
  }

  private async handleUpdate(parsed: ParsedStrategy, strategyId?: number, exchangeInstanceId?: string, source?: string, riskConfig?: StrategyRiskConfig): Promise<OrderResult | null> {
    return this.updateService.handleUpdate(parsed, strategyId, exchangeInstanceId, source, riskConfig);
  }

  private async handleCancel(parsed: ParsedStrategy, strategyId?: number, exchangeInstanceId?: string, routeId?: number): Promise<OrderResult | null> {
    return this.updateService.handleCancel(parsed, strategyId, exchangeInstanceId, routeId);
  }

  public async handleClose(parsed: ParsedStrategy, source: string, riskConfig: StrategyRiskConfig | undefined, strategyId?: number, targetPositionSide?: 'buy' | 'sell', exchangeInstanceId?: string): Promise<OrderResult | null> {
    return this.closeService.handleClose(parsed, source, riskConfig, strategyId, targetPositionSide, exchangeInstanceId);
  }

  public async manualClosePosition(params: {
      symbol: string;
      side?: 'buy' | 'sell';
      exchangeInstanceId?: string;
      strategyId?: number;
      orderId?: string;
      closeAmount?: string;
      closePercentage?: number;
      closePrice?: string;
      source?: string;
      routeId?: number;
      parserName?: string;
  }): Promise<OrderResult | null> {
      const parsed: ParsedStrategy = {
          action: 'close',
          symbol: params.symbol,
          orderId: params.orderId,
          closeAmount: params.closeAmount,
          closePercentage: params.closePercentage,
          closePrice: params.closePrice,
          raw: {
              source: params.source,
              routeId: params.routeId,
              parserName: params.parserName,
              closeAmount: params.closeAmount
          }
      };
      return this.handleClose(
          parsed,
          params.source || 'manual-api',
          undefined,
          params.strategyId,
          params.side,
          params.exchangeInstanceId
      );
  }

  private async handleOpen(parsed: ParsedStrategy, riskConfig: StrategyRiskConfig, source: string, strategyId?: number, exchangeInstanceId?: string, routeId?: number): Promise<OrderResult | null> {
    return this.openService.handleOpen(parsed, riskConfig, source, strategyId, exchangeInstanceId, routeId);
  }

  private async placeTpOrders(
      symbol: string,
      side: 'buy' | 'sell',
      tpOrders: { price: string, amount: string }[],
      riskConfig: StrategyRiskConfig,
      source: string,
      strategyId?: number,
      exchangeInstanceId?: string,
      scopeToken?: string
  ): Promise<boolean> {
        const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);

        // 1. Verify Position (Anti-Race Condition)
        try {
             const currentPos = await exchange.getPosition(symbol);
             const posSize = currentPos ? parseFloat(currentPos.size) : 0;
             if (posSize === 0) {
                 logger.warn(`[TradeExecutor] Position for ${symbol} is 0. Skipping TP placement.`);
                 return false;
             }
             const isLongPos = posSize > 0;
             const intendedSide = side === 'buy';
             if (isLongPos !== intendedSide) {
                  logger.warn(`[TradeExecutor] Position side mismatch for ${symbol}. Current: ${posSize}, Intended: ${side}. Skipping TP.`);
                  return false;
             }
        } catch (posErr) {
             logger.warn(`[TradeExecutor] Failed to verify position for ${symbol} before TP placement`, { error: posErr });
             return false;
        }

        if (tpOrders.length === 0) {
            logger.info(`[TradeExecutor] No TP targets for ${symbol}. Skipping TP placement.`);
            return true;
        }

        const isLong = side === 'buy';
        const tpType = riskConfig.tpOrderType || 'limit';
        const tpOrderMode: 'maker' | 'taker' = riskConfig.tpOrderMode
            ? riskConfig.tpOrderMode
            : (riskConfig.tpPostOnly === undefined ? 'maker' : (riskConfig.tpPostOnly ? 'maker' : 'taker'));
        const postOnly = tpType === 'limit' && tpOrderMode === 'maker';
        let placedCount = 0;

        for (const [index, tp] of tpOrders.entries()) {
             try {
                 const tpParams: OrderParams = {
                     symbol: symbol,
                     side: isLong ? 'sell' : 'buy',
                     amount: tp.amount,
                     reduceOnly: true,
                     text: buildTakeProfitOrderText(index + 1, scopeToken || source)
                 };

                 if (tpType === 'market') {
                     tpParams.type = 'market';
                     tpParams.triggerPrice = tp.price;
                     tpParams.triggerCondition = isLong ? 'ge' : 'le';
                 } else {
                     tpParams.type = 'limit';
                     tpParams.price = tp.price;
                     tpParams.postOnly = postOnly;
                 }

                 const result = await exchange.placeOrder(tpParams);
                 logger.info(`Placed TP-${index+1} (${tpType}, ${tpOrderMode}) for ${symbol}: ${tp.amount} @ ${tp.price}`);

                 if (strategyId) {
                     await auditService.log(strategyId, 'TP_ORDER_PLACED', {
                         index: index + 1,
                         price: tp.price,
                         amount: tp.amount,
                         type: tpType,
                         orderMode: tpOrderMode,
                         postOnly,
                         orderId: result.id
                     });
                 }
                 placedCount += 1;

             } catch (err: any) {
                 logger.warn(`Failed to place TP-${index+1} for ${symbol}`, formatError(err));
                 if (strategyId) {
                     await auditService.log(strategyId, 'TP_PLACEMENT_FAILED', {
                         index: index + 1,
                         price: tp.price,
                         error: err.message
                     });
                 }
             }
        }
        if (placedCount !== tpOrders.length) {
            logger.warn(`[TradeExecutor] TP placement incomplete for ${symbol}: ${placedCount}/${tpOrders.length}`);
            return false;
        }
        return true;
  }

  public async checkStrategyCorrelation(strategyId: number, eventType: 'TP_FILLED' | 'MANUAL_CLOSE' | 'ENTRY_FILLED') {
      try {
          const strategy = await Strategy.findByPk(strategyId);
          if (!strategy || !strategy.rawMessage) return;

          let discordId: string;
          try {
              const raw = JSON.parse(strategy.rawMessage);
              discordId = raw.id;
          } catch (e) { return; }

          const activeOrders = await Order.findAll({
              where: {
                  lifecycleStatus: ['PENDING', 'OPEN', 'PROTECTED'],
                  symbol: strategy.symbol,
                  // 回测导入的订单不参与实盘关联检查
                  backtestRunId: { [Op.is]: null },
              },
              include: [Strategy]
          });

          const siblings = activeOrders.filter(o => {
              try {
                  const strat = (o as any).Strategy;
                  if (!strat || !strat.rawMessage) return false;
                  const raw = JSON.parse(strat.rawMessage);
                  return raw.id === discordId;
              } catch (e) { return false; }
          });

          if (siblings.length === 0) return;
          if (siblings.length <= 1 && eventType !== 'MANUAL_CLOSE') {
              if (eventType === 'ENTRY_FILLED') return;
          }

          logger.info(`Checking Strategy Correlation for Strategy ${strategyId} (Event: ${eventType}, Siblings: ${siblings.length})`);

          if (eventType === 'TP_FILLED' || eventType === 'MANUAL_CLOSE') {
              const pending = siblings.filter(o => o.lifecycleStatus === 'PENDING');
              for (const p of pending) {
                  logger.info(`Correlation: Cancelling pending sibling order ${p.id} due to ${eventType}.`);
                  await this.handleCancel({
                      action: 'cancel',
                      symbol: p.symbol,
                      orderId: p.exchangeOrderId,
                      raw: {}
                  }, p.strategyId, p.exchangeInstanceId);
              }
          }

          if (eventType === 'TP_FILLED') {
              const openOrders = siblings.filter(o => ['OPEN', 'PROTECTED'].includes(o.lifecycleStatus));

              if (openOrders.length > 0) {
                   let totalSize = 0;
                   let weightedSum = 0;

                   for (const o of openOrders) {
                       const size = parseFloat(o.filledAmount || o.amount);
                       const price = parseFloat(o.filledPrice || o.price);
                       if (!isNaN(size) && !isNaN(price)) {
                           totalSize += size;
                           weightedSum += (price * size);
                       }
                   }

                   if (totalSize > 0) {
                       const avgPrice = weightedSum / totalSize;

                       const exchangeId = openOrders[0].exchangeInstanceId;
                       const exchange = this.services.exchangeRegistry.getExchange(exchangeId);
                       let precision = 2;
                       try {
                           const markets = await exchange.getMarkets();
                           const market = markets.find(m => m.symbol === openOrders[0].symbol);
                           if (market) precision = market.pricePrecision;
                       } catch (e) {
                           logger.debug('Failed to fetch market info for price precision in correlation SL update', formatError(e));
                       }

                       const newSL = avgPrice.toFixed(precision);

                       for (const o of openOrders) {
                           logger.info(`Correlation: Updating SL for sibling order ${o.id} to Avg Entry ${newSL}`);
                           const success = await this.handleUpdate({
                               action: 'update',
                               symbol: o.symbol,
                               stopLoss: newSL,
                               raw: {}
                           }, o.strategyId, o.exchangeInstanceId);

                           if (!success) {
                               logger.warn(`Correlation: Failed to update SL for ${o.id} to ${newSL}`);
                           }
                       }
                   }
              }
          }

      } catch (err: any) {
          logger.error(`Failed to check strategy correlation for ${strategyId}`, formatError(err));
      }
  }

  public stop(): void {
    this.noStopLossMonitor?.stop();
  }
}

export default new TradeExecutor();
