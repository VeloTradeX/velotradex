import logger, { logContext, formatError } from '../../utils/logger';
import { EventEmitter } from 'events';
import { IExchange, OrderParams, OrderResult, AccountBalance, Position, OpenOrder, MarketInfo, Ticker, Trade, ExchangeConfig, Candle } from './IExchange';
import { GateIORestClient } from './gate/GateIORestClient';
import { GateIOWSEventRouter } from './GateIOWSEventRouter';
import { GateIOWebSocket } from './GateIOWebSocket';
import { GateIOOrderPersistenceHandler } from './GateIOOrderPersistenceHandler';
import orderPersistenceHandler from '../OrderPersistenceHandler';
import { ProtectionPipeline } from '../ProtectionPipeline';
import { PendingProtection, Order } from '../../models';
import auditService from '../AuditService';
import tradingStatsService from '../TradingStatsService';
import fs from 'fs';
import path from 'path';
import { ensureGateOrderText, buildTpOrdersJson } from '../../utils/orderText';
import { withRetry } from '../../utils/retryUtils';
import { mapOrderResult, mapOpenOrderResult, mapPriceOrderResult, mapTradeResult, mapPositionResult, mapTickerResult, mapCandleRow, isScopedProtectionText, isPostOnlyImmediateMatchError } from './GateIOOrderMapper';
import { mapContractToMarketInfo, loadMarketsFromDict, toGateCandleInterval } from './GateIOSymbolUtils';
import { logHttpError, formatPriceWithMarket, computeProtectionTargetAmount } from './GateIOFormatter';
import { ensureTimeSynced } from './gate/GateTimeSync';
import { delay } from '../TradeMath';

export class GateIOExchange extends EventEmitter implements IExchange {
  id: string;
  name: string;
  private apiKey: string;
  private apiSecret: string;
  private fillListeners = new Map<string, (order: OrderResult) => void>();
  private markets: Map<string, MarketInfo> = new Map();
  private ws: GateIOWebSocket;
  private restClient: GateIORestClient;
  private wsTraceMap = new Map<string, { traceId: string; expireAt: number }>();
  private readonly wsTraceTtlMs = 30 * 24 * 60 * 60 * 1000;
  private eventRouter!: GateIOWSEventRouter;
  private orderPersistenceHandler!: GateIOOrderPersistenceHandler;

  /** Symbols currently in the opening flow (leverage/margin adjustment + order placement).
   *  WSEventRouter checks this to avoid false close detection during transient size=0 events. */
  public readonly pendingOpenSymbols = new Set<string>();

  constructor(config: ExchangeConfig) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;

    if (!this.apiKey || !this.apiSecret) {
      logger.warn(`GateIO Exchange ${this.id}: Credentials missing!`);
    }

    // Trim keys
    if (this.apiKey) this.apiKey = this.apiKey.trim();
    if (this.apiSecret) this.apiSecret = this.apiSecret.trim();

    this.restClient = new GateIORestClient(config);

    // WebSocket URL derivation
    let wsURL = config.wsURL;
    if (!wsURL) {
        wsURL = config.isTestnet 
            ? 'wss://ws-testnet.gate.com/v4/ws/futures/usdt'
            : 'wss://fx-ws.gateio.ws/v4/ws/usdt';
    }

    // WS 代理：兼容 proxy / proxyUrl 两种命名（UI 保存过两种格式）
    const wsProxy: string | undefined = (config.proxy || (config as any).proxyUrl) || undefined;
    this.ws = new GateIOWebSocket(wsURL, this.apiKey, this.apiSecret, wsProxy);

    this.initialize();
  }

  public async start(): Promise<void> {
      // 先在 WS 握手前把服务器时间同步好，避免签名偏差导致 AUTHENTICATION_FAILED
      await ensureTimeSynced(this.restClient.getBasePath()).catch(() => {});
      await this.ws.connect();
  }

  public async stop(): Promise<void> {
      await this.ws.disconnect();
  }

  public async testConnection(): Promise<{ success: boolean; http: boolean; ws: boolean; message: string; details?: any }> {
      const result = {
          success: false,
          http: false,
          ws: false,
          message: '',
          details: {} as any
      };

      // 1. HTTP Test (Balance)
      try {
          await this.getBalance('USDT');
          result.http = true;
      } catch (e: any) {
          result.message += `HTTP Error: ${e.message}; `;
      }

      // 2. WS Test
      try {
          // Create temp WS connection
          await this.ws.connect();
          await this.ws.waitForOpen();
          if (this.ws.getStats().isConnected) {
              result.ws = true;
          } else {
              result.message += 'WS Connect Timeout; ';
          }
          await this.ws.disconnect();
      } catch (e: any) {
          result.message += `WS Error: ${e.message}`;
      }

      result.success = result.http && result.ws;
      if (result.success) result.message = 'All systems operational';
      
      return result;
  }

  private async initialize() {
      this.setupWebSocket();
  }

  private setupWebSocket() {
      // Initialize EventRouter with reference to this (GateIOExchange) so it can call handleWsOrderUpdate
      this.eventRouter = new GateIOWSEventRouter(this, orderPersistenceHandler);
      this.orderPersistenceHandler = new GateIOOrderPersistenceHandler(this);

      this.ws.on('order_update', (order: any) => {
          // Route exactly once: resolve fill listeners, persist state, then fan out to Redis.
          this.eventRouter.route({ channel: 'futures.orders', result: order });
      });

      this.ws.on('position_update', (pos: any) => {
          this.eventRouter.route({ channel: 'futures.positions', result: pos });
      });

      this.ws.on('balance_update', (bal: any) => {
          this.eventRouter.route({ channel: 'futures.balances', result: bal });
      });
      
      this.ws.on('error', (err: any) => {
          logger.error('GateIO Exchange WS Error', formatError(err));
          // Prevent crash, WS class handles reconnection
      });
      
      this.ws.on('connected', () => {
          logger.info('GateIO Exchange WS Connected/Reconnected');
          // P1-6: 通知 TradeExecutor 对 PENDING 限价单做 REST 对账，
          // 覆盖 WS 断线期间成交但未推送事件的订单。
          this.emit('wsConnected');
      });
      
      this.ws.on('disconnected', () => {
          logger.warn('GateIO Exchange WS Disconnected');
          // 供 ExchangeInstanceManager 记录断连历史
          this.emit('disconnected');
      });
  }

  public setProtectionPipeline(pipeline: ProtectionPipeline): void {
      this.orderPersistenceHandler.setProtectionPipeline(pipeline);
  }

  private rememberTrace(key: string, traceId?: string | null) {
      if (!traceId) return;
      this.wsTraceMap.set(key, { traceId, expireAt: Date.now() + this.wsTraceTtlMs });
      if (this.wsTraceMap.size > 10000) {
          const now = Date.now();
          for (const [k, v] of this.wsTraceMap.entries()) {
              if (v.expireAt <= now) this.wsTraceMap.delete(k);
          }
      }
  }

  private getRememberedTrace(key: string): string | null {
      const entry = this.wsTraceMap.get(key);
      if (!entry) return null;
      if (entry.expireAt <= Date.now()) {
          this.wsTraceMap.delete(key);
          return null;
      }
      return entry.traceId;
  }

  private async handleWsOrderUpdate(rawOrder: any, traceBound: boolean = false) {
      const orderId = rawOrder.id?.toString();
      if (!orderId) {
          logger.warn('[GateIO] WS order update missing id, skipping', { rawOrder });
          return;
      }
      const status = rawOrder.status; // 'finished', 'open'

      if (!traceBound) {
          let traceId = this.getRememberedTrace(`o:${orderId}`);
          if (!traceId && rawOrder.text) {
              traceId = this.getRememberedTrace(`c:${rawOrder.text}`);
          }

          if (!traceId) {
              try {
                  const linkedOrder = await Order.findOne({
                      where: { exchangeOrderId: orderId },
                      attributes: ['strategyId']
                  });
                  if (linkedOrder?.strategyId) {
                      traceId = `celue-${linkedOrder.strategyId}`;
                  }
              } catch (e: any) {
                  logger.warn(`Failed to bind trace for WS order ${orderId}`, formatError(e));
              }
          }

          if (traceId) {
              this.rememberTrace(`o:${orderId}`, traceId);
              if (rawOrder.text) this.rememberTrace(`c:${rawOrder.text}`, traceId);
              await logContext.run(new Map([['traceId', traceId]]), async () => {
                  await this.handleWsOrderUpdate(rawOrder, true);
              });
              return;
          }
      }

      logger.info(`WS Order Update: ID=${orderId} Status=${status} Text=${rawOrder.text || ''} FillPrice=${rawOrder.fill_price} Left=${rawOrder.left}`);

      // P0-2: 部分成交检测。finished 订单 left>0 时若 |size|-|left| > 0 表示有实际成交量，
      // 必须按 fill 处理（放保护），而不是当成纯取消。
      const rawSize = Math.abs(parseFloat(rawOrder.size ?? '0'));
      const left = rawOrder.left != null ? parseFloat(rawOrder.left) : 0;
      const filledQty = Number.isFinite(rawSize) && Number.isFinite(left) ? Math.max(0, rawSize - left) : 0;

      // Resolve fillListener only when the order reaches a meaningful state:
      // - status 'finished'（终态：全部成交/取消/超时拒绝）→ 按实际成交量判定 filled/cancelled
      // - 未 finished 但已有实际成交量（部分成交）→ 视为 filled，尽快挂保护
      // open 态且零成交的推送（如限价单创建时的状态快照）必须保持等待，
      // 否则未成交的限价单会被误判为 cancelled，导致上层标 RISK_UNPROTECTED。
      if (this.fillListeners.has(orderId)) {
          if (status === 'finished' || filledQty > 1e-8) {
              const listener = this.fillListeners.get(orderId)!;
              const finalStatus = filledQty > 1e-8 ? 'filled' : 'cancelled';
              const result: OrderResult = {
                  id: orderId,
                  status: finalStatus,
                  amount: (filledQty > 1e-8 ? filledQty : rawSize).toString(),
                  price: rawOrder.fill_price || rawOrder.price,
                  raw: rawOrder
              };
              listener(result);
              this.fillListeners.delete(orderId);
          }
      }

      // DB persistence handled asynchronously by GateIOOrderPersistenceHandler
      if (status === 'finished') {
          if (filledQty > 1e-8) {
              // 部分或全部成交：把实际成交量合成 fill 事件交给 persistence handler。
              const sign = parseFloat(rawOrder.size) < 0 ? -1 : 1;
              const filledEvent = { ...rawOrder, left: '0', size: (sign * filledQty).toString() };
              this.orderPersistenceHandler.handleOrderFilled(orderId, filledEvent).catch(err => {
                  logger.error(`handleOrderFilled failed for ${orderId}`, { error: err });
              });
              if (left > 1e-8) {
                  // 剩余部分被取消：仅审计，不关闭订单（仓位已存在且已挂保护）。
                  auditService.logByExchangeOrderId(orderId, 'ORDER_PARTIAL_CANCEL_WS', {
                      text: rawOrder.text,
                      filled: filledQty,
                      left,
                  }).catch(err => {
                      logger.warn(`Failed to log partial cancel for ${orderId}`, { error: err });
                  });
              }
          } else {
              this.orderPersistenceHandler.handleOrderCancelled(orderId, rawOrder).catch(err => {
                  logger.error(`handleOrderCancelled failed for ${orderId}`, { error: err });
              });
          }
      }
  }

  public async waitForOrderFill(orderId: string, symbol: string, timeoutMs: number = 60000): Promise<OrderResult> {
      return new Promise((resolve, reject) => {
          let timer: NodeJS.Timeout | null = null;
          let settled = false;

          const settle = (fn: () => void) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              this.fillListeners.delete(orderId);
              fn();
          };

          // P0-3 双检（第一检）：先注册 WS listener，再立刻 REST 查一次终态。
          // 这样即使成交事件在下单返回与 listener 注册之间到达（被错过），
          // REST 预检也能兜住，保护不会延迟到超时兜底。
          this.fillListeners.set(orderId, (order) => {
              settle(() => {
                  if (order.status === 'filled') {
                      resolve(order);
                  } else {
                      reject(new Error(`Order ${orderId} ended with status: ${order.status}`));
                  }
              });
          });

          const filledAmountOf = (raw: any): number => {
              const rawSize = Math.abs(parseFloat(raw?.size ?? '0'));
              const left = raw?.left != null ? parseFloat(raw.left) : NaN;
              if (Number.isFinite(rawSize) && Number.isFinite(left)) {
                  return Math.max(0, rawSize - left);
              }
              return rawSize;
          };

          this.getOrder(orderId, symbol)
              .then(order => {
                  if (settled) return;
                  const raw = order.raw || {};
                  if (order.status === 'finished' && filledAmountOf(raw) > 1e-8) {
                      settle(() => {
                          resolve({ id: order.id, status: 'filled', amount: order.amount, price: order.price, raw });
                      });
                  }
              })
              .catch(err => {
                  // 预检失败不致命：继续依赖 WS listener（NoStopLossMonitor / 重连对账兜底）。
                  logger.warn(`waitForOrderFill pre-check failed for ${orderId}`, formatError(err));
              });

          // P0-1: timeoutMs === 0 表示无限等待（限价挂单），不设超时定时器。
          if (timeoutMs > 0) {
              timer = setTimeout(() => {
                  settle(() => {
                      this.getOrder(orderId, symbol)
                          .then(order => {
                              const raw = order.raw || {};
                              if (order.status === 'finished' && filledAmountOf(raw) > 1e-8) {
                                  resolve({ id: order.id, status: 'filled', amount: order.amount, price: order.price, raw });
                              } else {
                                  reject(new Error(`Timeout waiting for order fill: ${orderId}`));
                              }
                          })
                          .catch(() => {
                              reject(new Error(`Timeout waiting for order fill: ${orderId}`));
                          });
                  });
              }, timeoutMs);
          }
      });
  }

  private async placeStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text: string = 'sl-trigger', amount?: string) {
      return this.updateStopLoss(symbol, side, price, text, amount);
  }

  private async placeTakeProfit(symbol: string, side: 'buy' | 'sell', price: string, text: string = 'tp-trigger', amount?: string) {
      return this.updateTakeProfit(symbol, side, price, text, amount);
  }

  private async normalizeProtectionAmount(symbol: string, side: 'buy' | 'sell', amount?: string): Promise<string | null> {
      const position = await this.getPosition(symbol);
      if (!position || parseFloat(position.size) === 0) {
          return null;
      }
      return computeProtectionTargetAmount(position.size, side, amount);
  }

  public async updateTakeProfit(symbol: string, side: 'buy' | 'sell', price: string, text: string = 'tp-trigger', amount?: string, retrying = false): Promise<boolean> {
       const normalizedText = ensureGateOrderText(text, 'tp-trigger');
       let normalizedAmount: string | null = null;
       try {
          normalizedAmount = await this.normalizeProtectionAmount(symbol, side, amount);
          if (!normalizedAmount) {
              logger.warn(`[GateIO] Position for ${symbol} is not available for TP update. Skipping.`);
              return true;
          }
       } catch (e) {
          logger.warn(`[GateIO] Failed to verify position for ${symbol} before TP Update. Skipping.`, { error: e });
          return true;
       }

       const isLong = side === 'buy';
       const rule = isLong ? 1 : 2;
       const closeSide = isLong ? 'sell' : 'buy';

       const tpBody = {
          initial: {
              contract: symbol,
              size: closeSide === 'buy' ? parseFloat(normalizedAmount) : -parseFloat(normalizedAmount),
              price: '0',
              close: false,
              tif: 'ioc',
              text: normalizedText,
              // CRITICAL: Must use camelCase `reduceOnly`, NOT snake_case `reduce_only`.
              // gate-api SDK ObjectSerializer only reads camelCase property names from JS objects
              // and emits snake_case to the API. Passing `reduce_only` causes it to be silently
              // dropped, resulting in a reverse-opening order instead of a closing order.
              // See: gate-api SDK FuturesInitialOrder.attributeTypeMap: name='reduceOnly', baseName='reduce_only'
              reduceOnly: true
          },
          trigger: {
              // CRITICAL: Must use camelCase `strategyType`/`priceType`, NOT snake_case.
              // gate-api SDK ObjectSerializer only reads camelCase property names.
              // See: FuturesPriceTrigger.attributeTypeMap: name='strategyType', baseName='strategy_type'
              strategyType: 0,
              priceType: 0,
              price: await this.formatPrice(symbol, price, retrying),
              rule: rule,
              expiration: 86400 * 30
          }
      };

      try {
        // 1. Find Existing TP Orders
        const priceOrders = await this.getPriceOrders(symbol);
        const oldTPOrders = priceOrders.filter(o => {
            const orderText = String(o.text || o.initial?.text || '');
            if (isScopedProtectionText(normalizedText)) {
                return orderText === normalizedText;
            }

            if (orderText && (orderText.includes('tp-') || orderText.includes('take-profit'))) return true;

            if (o.trigger?.rule === rule) {
                 // SDK deserializes to camelCase (reduceOnly), also check snake_case for robustness
                 const isReduceOnly = o.initial?.reduceOnly ?? o.initial?.reduce_only ?? o.reduce_only;
                 if (isReduceOnly) return true;
            }
            return false;
        });

        // 2. Cancel Old TPs
        if (oldTPOrders.length > 0) {
            logger.info(`Cancelling ${oldTPOrders.length} existing TP orders before update...`);
            for (const order of oldTPOrders) {
                await this.cancelPriceOrder(order.id, symbol);
            }
        }

        // 3. Place New TP
        await withRetry(
          () => this.restClient.createPriceOrder(tpBody),
          { label: `updateTakeProfit ${symbol}` }
        );
        return true;
      } catch (error: any) {
        // Handle "User exist close position order" (Race condition or failed cancel)
        if (error.label === 'AUTO_USER_EXIST_POSITION_ORDER') {
            logger.warn(`TP Placement Race: Protection already exists for ${symbol} (Rule ${rule}). Assuming success.`);
            return true;
        }

        if (!retrying && (error.responseBody?.message?.includes('trigger_price') || error.label === 'INVALID_PARAM_VALUE')) {
            logger.warn(`Invalid TP price for ${symbol}, retrying with fresh market data...`);
            return this.updateTakeProfit(symbol, side, price, normalizedText, normalizedAmount || amount, true);
        }

        logHttpError('Failed to update Take Profit', error, { symbol, side, price, text: normalizedText });
        return false;
      }
  }

  // --- Core Trading ---

  private async safePlaceProtection(symbol: string, side: 'buy' | 'sell', price: string, type: 'sl' | 'tp', referencePrice?: number): Promise<boolean> {
      try {
          let lastPrice = referencePrice;
          if (!lastPrice) {
              const ticker = await this.getTicker(symbol);
              lastPrice = parseFloat(ticker.lastPrice);
          }
          
          const triggerPrice = parseFloat(price);
          const isLong = side === 'buy';

          // Validate Gate.io Trigger Rules
          // Rule 1: Trigger > Price (Close Short SL / Close Long TP)
          // Rule 2: Trigger < Price (Close Long SL / Close Short TP)
          
          let isValid = false;
          // Epsilon for float comparison
          const EPSILON = lastPrice * 0.0001; // 0.01% buffer

          if (type === 'sl') {
              // Stop Loss
              if (isLong) {
                  // Long SL: Must be BELOW current price (Rule 2)
                  // Allow exactly at entry price (breakeven = lastPrice) while still
                  // blocking SL prices that would trigger immediately.
                  if (triggerPrice <= lastPrice - EPSILON) isValid = true;
                  else logger.warn(`Skipping Immediate Long SL: Trigger ${triggerPrice} > Last ${lastPrice} - EPSILON (Rule 2 violation)`);
              } else {
                  // Short SL: Must be ABOVE current price (Rule 1)
                  if (triggerPrice >= lastPrice + EPSILON) isValid = true;
                  else logger.warn(`Skipping Immediate Short SL: Trigger ${triggerPrice} < Last ${lastPrice} + EPSILON (Rule 1 violation)`);
              }
          } else {
              // Take Profit
              if (isLong) {
                  // Long TP: Must be ABOVE current price (Rule 1)
                  if (triggerPrice >= lastPrice + EPSILON) isValid = true;
                  else logger.warn(`Skipping Immediate Long TP: Trigger ${triggerPrice} < Last ${lastPrice} + EPSILON (Rule 1 violation)`);
              } else {
                  // Short TP: Must be BELOW current price (Rule 2)
                  if (triggerPrice <= lastPrice - EPSILON) isValid = true;
                  else logger.warn(`Skipping Immediate Short TP: Trigger ${triggerPrice} > Last ${lastPrice} - EPSILON (Rule 2 violation)`);
              }
          }

          if (isValid) {
              if (type === 'sl') {
                  await this.placeStopLoss(symbol, side, price);
              } else {
                  await this.placeTakeProfit(symbol, side, price);
              }
              logger.info(`Immediate ${type.toUpperCase()} placed for ${symbol} @ ${price}`);
              return true;
          }
          return false;
      } catch (err: any) {
          logger.warn(`Failed to check/place immediate protection ${type}`, formatError(err, {
              path: err.path ?? err.config?.url,
              requestBody: err.requestBody ?? err.config?.data,
              responseBody: err.responseBody ?? err.response?.data
          }));
          return false;
      }
  }

  public async placeOrder(params: OrderParams): Promise<OrderResult> {
    // Enforce Cross Margin for opening orders (User Requirement)
    if (!params.reduceOnly) {
        try {
            // Use listPositions (not getPosition) to check the current leverage setting.
            // getPosition() returns null when there's no position, so we can't check
            // the leverage setting. listPositions() returns entries for all contracts
            // (including zero-size ones) with their current leverage setting.
            const allPositions = await this.restClient.listPositions();
            const contractEntry = allPositions.find((p: any) => p.contract === params.symbol);
            // Gate.io uses leverage '0' to represent Cross Margin
            const isCross = contractEntry && contractEntry.leverage === '0';

            if (!isCross) {
                logger.info(`Enforcing Cross Margin for ${params.symbol} (Current leverage: ${contractEntry?.leverage ?? 'none'})`);
                await this.setMarginMode(params.symbol, 'cross');
            }
        } catch (error: any) {
            logger.error(`Failed to ensure Cross Margin for ${params.symbol}`, formatError(error));
            throw new Error(`Cross Margin Check Failed: ${error.message}`);
        }
    }

    // Handle Trigger Orders (e.g. Market TP)
    if (params.triggerPrice) {
        return this.placeTriggerOrder(params);
    }

    // Gate.io Order Payload
    // If market order, price must be 0
    const price = params.type === 'market' ? '0' : (params.price || '0');
    // tif (Time in Force): gtc, ioc, poc
    // For market order: tif='ioc' is common
    let tif = params.type === 'market' ? 'ioc' : (params.timeInForce?.toLowerCase() || 'gtc');
    if (params.type === 'limit' && params.postOnly === true) {
        tif = 'poc';
    }

    const orderText = ensureGateOrderText(params.text, 'trader');
    const bodyObj: any = {
      contract: params.symbol,
      size: params.side === 'buy' ? parseFloat(params.amount) : -parseFloat(params.amount), // Long +, Short -
      price: price,
      tif: tif,
      text: orderText,
    };

    // CRITICAL: Must use camelCase `reduceOnly`, NOT snake_case `reduce_only`.
    // gate-api SDK ObjectSerializer only reads camelCase property names from JS objects
    // and emits snake_case to the API. Passing `reduce_only` causes it to be silently
    // dropped, resulting in a reverse-opening order instead of a closing order.
    // See: gate-api SDK FuturesOrder.attributeTypeMap: name='reduceOnly', baseName='reduce_only'
    if (params.reduceOnly) {
      bodyObj.reduceOnly = true;
    }

    // Gate v4.106.86+ 订单自带 TP/SL（gate-api >= 7.2.100 支持 tpslTpTriggerPrice/tpslSlTriggerPrice）。
    // SL 由服务器在下单/成交时托管，彻底消除「成交→挂保护」之间的裸仓竞态窗口。
    if (params.tpslTpTriggerPrice) {
      bodyObj.tpslTpTriggerPrice = params.tpslTpTriggerPrice;
    }
    if (params.tpslSlTriggerPrice) {
      bodyObj.tpslSlTriggerPrice = params.tpslSlTriggerPrice;
    }
    const attachedSl = !!params.tpslSlTriggerPrice;
    const attachedTp = !!params.tpslTpTriggerPrice;
    // 多 TP 场景：自带 TP1 仅作过渡保护，成交回调后由管线撤销自带 TP 再挂多档限价 TP；
    // 单 TP 场景：SL+TP 均自带，post-fill 无需再挂任何保护单。
    const multiTpTakeover = attachedTp && (params.tpOrders?.length ?? 0) > 1;
    const pendingStopLoss = attachedSl ? null : (params.stopLoss || null);
    const pendingTakeProfit = attachedTp && !multiTpTakeover ? null : (params.takeProfit || null);
    const pendingTpOrdersJson = (attachedTp && (params.tpOrders?.length ?? 0) <= 1)
      ? null
      : buildTpOrdersJson(params.tpOrders ?? null, attachedSl);
    const needsPendingProtection = !!(pendingStopLoss || pendingTakeProfit || pendingTpOrdersJson);

    if (params.type === 'market') {
       // Gate market order price=0
    }
    
    let data;
    const clientOrderId = orderText;
    bodyObj.text = clientOrderId;
    const currentTraceId = logContext.getStore()?.get('traceId');
    this.rememberTrace(`c:${clientOrderId}`, currentTraceId);

    // ATOMICITY: Write to DB *before* placing order
    // Use clientOrderId as temporary key.
    if (needsPendingProtection) {
        try {
            await PendingProtection.create({
                orderId: clientOrderId,
                symbol: params.symbol,
                side: params.side,
                stopLoss: pendingStopLoss,
                takeProfit: pendingTakeProfit,
                tpOrdersJson: pendingTpOrdersJson,
            });
            logger.info(`Persisted pending protection (Pre-Order) for ${clientOrderId}`, {
                attachedSl, attachedTp, multiTpTakeover,
            });
        } catch (dbErr) {
            logger.error(`Failed to persist pending protection for ${clientOrderId}`, { error: dbErr });
            // Should we abort? If DB fails, we might not want to place order without protection.
            // But let's proceed and try to save later? No, safest is to throw or warn.
            // User requested Atomicity.
        }
    }

    // 市价单 stop-match 安全校验重试：Gate 测试网薄盘口存在 ask1 相对 mark 瞬时跳空的异常，
    // 此时买入市价单会被 Gate 内部安全校验拒绝（"stop match price ... less than ask1"），
    // 盘口恢复后同一参数的订单立即可成交，因此对市价单重试一次（仅该特定错误）。
    const placeWithRetry = async (attempt: number): Promise<any> => {
      try {
        return await this.restClient.createOrder(bodyObj);
      } catch (error: any) {
        if (attempt < 2 && params.type === 'market' && /stop match price/i.test(String(error?.message || ''))) {
          logger.warn(`Market order rejected by Gate stop-match safety check (transient book spike), retrying (${attempt}/1)`, formatError(error));
          await delay(2000);
          return placeWithRetry(attempt + 1);
        }
        throw error;
      }
    };

    try {
      logger.info(`Placing Order via REST: ${JSON.stringify(bodyObj)}`);
      data = await placeWithRetry(1);
    } catch (error: any) {
        if (isPostOnlyImmediateMatchError(error)) {
            logger.warn('PostOnly order rejected', formatError(error));
            await this.cleanupPendingProtection(clientOrderId);
            throw error;
        }

        logHttpError('GateIO placeOrder failed', error, {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            reduceOnly: params.reduceOnly || false
        });

        await this.cleanupPendingProtection(clientOrderId);
        throw error;
    }
      
      const orderId = data.id?.toString();
      if (!orderId) {
          throw new Error(`Gate.io placeOrder returned no order ID (data=${JSON.stringify(data)})`);
      }
      this.rememberTrace(`o:${orderId}`, currentTraceId);
      
      // Post-Order: Migrate Protection from ClientID to RealID
      if (needsPendingProtection) {
          try {
              // Check if already migrated by WS handler
              const existing = await PendingProtection.findByPk(orderId);
              if (!existing) {
                  // Create new record with Real ID
                  await PendingProtection.create({
                      orderId: orderId,
                      symbol: params.symbol,
                      side: params.side,
                      stopLoss: pendingStopLoss,
                      takeProfit: pendingTakeProfit,
                      tpOrdersJson: pendingTpOrdersJson,
                  });
                  logger.info(`Migrated pending protection from ${clientOrderId} to ${orderId}`);
              } else {
                  logger.info(`Pending protection for ${orderId} already exists (likely migrated by WS).`);
              }
              
              // Ensure temporary record is deleted
              await PendingProtection.destroy({ where: { orderId: clientOrderId } });
          } catch (dbErr: any) {
              logger.error(`Failed to migrate pending protection for ${orderId}`, formatError(dbErr));
          }
      }
      
      let slPlaced = false;
      let tpPlaced = false;

      // IMMEDIATE PROTECTION PLACEMENT
      // DISABLED: To avoid race conditions with WS handlers.
      // WS handler will receive the 'finished' status almost immediately for market orders
      // and will handle the protection placement via PendingProtection logic.
      // Having both REST and WS try to place protection causes "Protection already exists" warnings
      // and unnecessary API calls.
      
      logger.info(`Order ${orderId} placed (status: ${data.status}). Delegating protection placement to WS handler.`);

      // P0-2: finished + left>0 时按实际成交量返回，避免保护单按请求量计算。
      const rawSize = Math.abs(parseFloat(data.size ?? '0'));
      const rawLeft = data.status === 'finished' && data.left != null
          ? Math.abs(parseFloat(data.left ?? '0'))
          : 0;
      const filledAmount = Math.max(0, rawSize - rawLeft);

      return {
        id: orderId,
        status: data.status,
        amount: (filledAmount > 1e-8 ? filledAmount : rawSize).toString(), // Ensure positive amount
        price: data.fillPrice || params.price,
        raw: data,
        slPlaced: false, // Defer to WS
        tpPlaced: false  // Defer to WS
      };
  }

  private async cleanupPendingProtection(clientOrderId: string): Promise<void> {
    try {
      await PendingProtection.destroy({ where: { orderId: clientOrderId } });
    } catch (cleanupErr) {
      logger.error(`Failed to cleanup pending protection for ${clientOrderId}`, { error: cleanupErr });
    }
  }

  private async placeTriggerOrder(params: OrderParams, retrying = false): Promise<OrderResult> {
    let rule = 0;
    if (params.triggerCondition === 'ge') rule = 1;
    else if (params.triggerCondition === 'le') rule = 2;
    else {
        throw new Error('triggerCondition (ge/le) required for trigger order');
    }

    const size = params.side === 'buy' ? parseFloat(params.amount) : -parseFloat(params.amount);

    const bodyObj = {
        initial: {
            contract: params.symbol,
            size: size,
            price: params.type === 'market' ? '0' : (params.price || '0'),
            tif: params.type === 'market' ? 'ioc' : 'gtc',
            text: ensureGateOrderText(params.text, 'trigger'),
            // CRITICAL: Must use camelCase `reduceOnly`, NOT snake_case `reduce_only`.
            // gate-api SDK ObjectSerializer only reads camelCase property names from JS objects
            // and emits snake_case to the API. Passing `reduce_only` causes it to be silently
            // dropped, resulting in a reverse-opening order instead of a closing order.
            // See: gate-api SDK FuturesInitialOrder.attributeTypeMap: name='reduceOnly', baseName='reduce_only'
            reduceOnly: params.reduceOnly || false
        },
        trigger: {
            // CRITICAL: Must use camelCase `strategyType`/`priceType`, NOT snake_case.
            // gate-api SDK ObjectSerializer only reads camelCase property names.
            strategyType: 0,
            priceType: 0,
            price: await this.formatPrice(params.symbol, params.triggerPrice!, retrying),
            rule: rule,
            expiration: 86400 * 30
        }
    };

    try {
        const data = await withRetry(
            () => this.restClient.createPriceOrder(bodyObj),
            { label: `placeTriggerOrder ${params.symbol}` }
        );
        return {
            id: data.id?.toString() ?? '',
            status: 'open',
            amount: params.amount,
            price: params.triggerPrice,
            raw: data
        };
    } catch (error: any) {
        if (!retrying && (error.responseBody?.message?.includes('trigger_price') || error.label === 'INVALID_PARAM_VALUE')) {
            logger.warn(`Invalid trigger price for ${params.symbol}, retrying with fresh market data...`);
            return this.placeTriggerOrder(params, true);
        }

        logHttpError('GateIO placeTriggerOrder failed', error, {
          symbol: params.symbol,
          side: params.side,
          triggerPrice: params.triggerPrice,
          triggerCondition: params.triggerCondition
        });
        throw error;
    }
  }

  public async amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult> {
    try {
      let newSize: number | undefined;

      // If amount is specified, we need the side to determine the signed size
      if (amount) {
          try {
              const order = await this.getOrder(orderId, symbol);
              const isBuy = parseFloat(order.amount!) > 0 || (order.raw?.size && parseFloat(order.raw.size) > 0);
              // Note: getOrder returns OrderResult where amount is usually absolute, but raw has size
              // Actually getOrder implementation maps size to amount (absolute).
              // We need to check raw.size or infer from somewhere.
              // Let's check getOrder implementation (it calls GET /orders).
              // GateIO GET /orders returns 'size' (signed).
              
              const rawSize = order.raw?.size ? parseFloat(order.raw.size) : 0;
              const side = rawSize >= 0 ? 'buy' : 'sell';
              
              newSize = side === 'buy' ? parseFloat(amount) : -parseFloat(amount);
          } catch (err) {
              // If we can't get the order (e.g. rate limit or not found), we can't safely determine side.
              // We might default to 'buy' or throw?
              // Or we assume the user passed a signed string in 'amount' if they knew? 
              // But IExchange says 'amount' is string.
              logger.warn(`Could not determine side for amendOrder ${orderId}. Assuming Buy or User provided signed amount?`, { error: err });
              // Fallback: assume amount is absolute and side is buy? OR fail?
              // Safest is to fail if we can't determine side.
              throw new Error(`Cannot amend size: failed to fetch original order to determine side.`);
          }
      }

      logger.info(`Amending Order via REST: ID=${orderId} Contract=${symbol} Price=${price} Size=${newSize}`);

      const amendBody: any = { contract: symbol };
      if (price) amendBody.price = price;
      if (newSize !== undefined) amendBody.size = newSize;

      const result = await withRetry(
        () => this.restClient.amendOrder(orderId, amendBody),
        { label: `amendOrder ${orderId}` }
      );

      return {
        id: result.id.toString(),
        status: result.status,
        amount: Math.abs(result.size).toString(),
        price: result.price,
        raw: result
      };

    } catch (error: any) {
      logger.error('GateIO amendOrder failed', formatError(error, {
        path: error.path,
        requestBody: { orderId, symbol, price, amount }
      }));
      throw error;
    }
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      logger.info(`Cancelling Order via REST: ID=${orderId} Contract=${symbol}`);
      await withRetry(
        () => this.restClient.cancelOrder(orderId, symbol),
        { label: `cancelOrder ${orderId}` }
      );
      return true;
    } catch (error: any) {
      logger.error('GateIO cancelOrder failed', formatError(error, {
        path: error.path,
        requestBody: { orderId, symbol }
      }));
      return false;
    }
  }

  public async cancelPriceOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      logger.info(`Cancelling Price Order: ${orderId} for ${symbol}`);
      await withRetry(
        () => this.restClient.cancelPriceOrder(orderId),
        { label: `cancelPriceOrder ${orderId}` }
      );
      return true;
    } catch (error: any) {
      // If order not found, consider it cancelled
      if (error.label === 'AUTO_ORDER_NOT_FOUND') {
          logger.warn(`Price Order ${orderId} not found (already cancelled?)`);
          return true;
      }
      logHttpError('GateIO cancelPriceOrder failed', error, { orderId, symbol });
      return false;
    }
  }

  /**
   * 撤销入场单自带的 TP 腿（多 TP 接管场景）。
   *
   * 自带 TP/SL 成交后在服务端表现为 order_type=close-long-order/close-short-order 的
   * price-triggered 单（read-only，通过 me_order_id 绑定源订单）。TP 与 SL 同为
   * close-*-order，靠 trigger.rule 区分：多头 TP rule=1 / SL rule=2；空头 TP rule=2 / SL rule=1。
   * 本方法只撤销 TP 方向的腿，绝不触碰自带 SL。
   */
  public async cancelAttachedTpslTp(symbol: string, side: 'buy' | 'sell', entryOrderId: string): Promise<number> {
    const isLong = side === 'buy';
    const tpRule = isLong ? 1 : 2;
    const attachedOrderType = isLong ? 'close-long-order' : 'close-short-order';

    try {
      const priceOrders = await this.getPriceOrders(symbol);
      const candidates = priceOrders.filter((o: any) => {
        const orderType = String(o.orderType ?? o.order_type ?? o.raw?.order_type ?? '');
        if (orderType !== attachedOrderType) return false;
        if (o.trigger?.rule !== tpRule) return false;
        // entryOrderId 为空（全平撤保护等场景）：不按源订单过滤，退化为类型+rule 匹配。
        if (!entryOrderId) return true;
        const meOrderId = o.meOrderId != null ? String(o.meOrderId) : String(o.raw?.me_order_id ?? '');
        if (!meOrderId) return true; // 字段缺失时退化为类型+rule匹配
        return meOrderId === String(entryOrderId);
      });

      let cancelled = 0;
      for (const o of candidates) {
        if (await this.cancelPriceOrder(o.id, symbol)) {
          cancelled++;
        }
      }
      if (candidates.length > 0) {
        logger.info(`[GateIO] cancelAttachedTpslTp: ${cancelled}/${candidates.length} attached TP cancelled for ${symbol} ${side} (entry ${entryOrderId})`);
      }
      return cancelled;
    } catch (error: any) {
      logHttpError('GateIO cancelAttachedTpslTp failed', error, { symbol, side, entryOrderId });
      return 0;
    }
  }

  public async updateStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text: string = 'sl-trigger-breakeven', amount?: string, retrying = false): Promise<string | null> {
      const normalizedText = ensureGateOrderText(text, 'sl-trigger');
      // Use the passed amount directly as the SL quantity (per-order protection)
      // This ensures each order has its own independent SL covering only its filled size
      let effectiveAmount: string | null = null;
      if (amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > 0) {
          effectiveAmount = amount;
      } else {
          // Fallback only if no amount was provided (shouldn't happen in normal flow)
          try {
              const fallback = await this.normalizeProtectionAmount(symbol, side, undefined);
              effectiveAmount = fallback;
          } catch (e) {
              logger.warn(`[GateIO] No SL amount available for ${symbol}. Skipping.`);
              return null;
          }
          if (!effectiveAmount) {
              logger.warn(`[GateIO] Position not available for SL ${symbol}. Skipping.`);
              return null;
          }
      }

      const isLong = side === 'buy';
      const rule = isLong ? 2 : 1;
      const closeSide = isLong ? 'sell' : 'buy';

      // Detect if this is a position-level SL (text contains 't-sl-pos-')
      const isPositionLevelSL = normalizedText.includes('t-sl-pos-');

      const slBody: any = {
        initial: {
          contract: symbol,
          price: '0',
          close: false,
          // CRITICAL: Must use camelCase `reduceOnly`, NOT snake_case `reduce_only`.
          // gate-api SDK ObjectSerializer only reads camelCase property names from JS objects
          // and emits snake_case to the API. Passing `reduce_only` causes it to be silently
          // dropped, resulting in a reverse-opening order instead of a closing order.
          // See: gate-api SDK FuturesInitialOrder.attributeTypeMap: name='reduceOnly', baseName='reduce_only'
          reduceOnly: true,
          tif: 'ioc',
          text: normalizedText
        },
        trigger: {
          // CRITICAL: Must use camelCase `strategyType`/`priceType`, NOT snake_case.
          // gate-api SDK ObjectSerializer only reads camelCase property names.
          strategyType: 0,
          priceType: 0,
          price: await this.formatPrice(symbol, price, retrying),
          rule: rule,
          expiration: 86400 * 30
        },
      };

      // In dual mode, auto_size: 'close' is not supported
      // Always use explicit size
      slBody.initial.size = closeSide === 'buy' ? parseFloat(effectiveAmount) : -parseFloat(effectiveAmount);

      // Gate.io Strategy: Cannot have >1 close-position order.
      // Must Cancel Old -> Place New.
      // We implement "Rollback" if Place New fails.

      let oldSLOrders: any[] = [];

      try {
        // 1. Find Existing SL Orders
        const priceOrders = await this.getPriceOrders(symbol);

        // For position-level SL (text contains 't-sl-pos-'), cancel all SL orders for this side
        // Gate.io returns isReduceOnly/isClose as false even for reduce_only orders, so use text prefix + rule
        if (isPositionLevelSL) {
          // 自带 SL 腿（入场单 tpsl_sl_trigger_price 生成的 close-*-order 单）也要一并撤销，
          // 否则移动保本后旧 SL 仍然挂着，形成双重止损。
          const attachedSlType = isLong ? 'close-long-order' : 'close-short-order';
          oldSLOrders = priceOrders.filter(o => {
            const orderRule = o.trigger?.rule;
            const orderText = String(o.text || o.initial?.text || '');
            const orderType = String(o.orderType ?? o.order_type ?? o.raw?.order_type ?? '');

            if (orderType === attachedSlType && orderRule === rule) return true;
            if (orderRule !== rule) return false;
            if (!orderText.startsWith('t-sl-pos-')) return false;
            return true;
          });
        } else {
          oldSLOrders = priceOrders.filter(o => {
            const orderText = String(o.text || o.initial?.text || '');
            return orderText === normalizedText;
          });
        }

        // 2. Cancel Old SLs
        if (oldSLOrders.length > 0) {
            logger.info(`Cancelling ${oldSLOrders.length} existing SL orders before update...`);
            for (const order of oldSLOrders) {
                await this.cancelPriceOrder(order.id, symbol);
                logger.info(`Cancelled SL order ${order.id} (text: ${order.text || order.initial?.text})`);
            }
        }

        // 3. Place New SL
        const data = await withRetry(
          () => this.restClient.createPriceOrder(slBody),
          { label: `updateStopLoss ${symbol}` }
        );
        const newOrderId = data.id?.toString();
        if (!newOrderId) {
            throw new Error(`Gate.io updateStopLoss returned no order ID (data=${JSON.stringify(data)})`);
        }

        logger.info(`Updated Stop Loss for ${symbol} to ${price} (New ID: ${newOrderId}, Text: ${normalizedText})`);
        return newOrderId;

      } catch (error: any) {
        // Handle "User exist close position order" (Race condition)
        if (error.label === 'AUTO_USER_EXIST_POSITION_ORDER' ||
            error.responseBody?.message?.includes('user exist close position order')) {
            logger.warn(`SL Update Race: Protection already exists for ${symbol} (Rule ${rule}). Querying existing SL...`);

            // Query existing SL order and return its ID
            try {
              const priceOrders = await this.getPriceOrders(symbol);
              const existingSL = priceOrders.find((o: any) => {
                if (o.trigger?.rule !== rule) return false;
                const orderText = String(o.text || o.initial?.text || '');
                if (!orderText.startsWith('t-sl-pos-')) return false;
                const orderSymbol = o.initial?.contract || o.contract || '';
                return orderSymbol === symbol;
              });

              if (existingSL) {
                const existingId = existingSL.id.toString();
                logger.info(`SL Update Race: Found existing SL for ${symbol} (ID: ${existingId}). Returning existing ID.`);
                return existingId;
              } else {
                logger.warn(`SL Update Race: No existing SL found for ${symbol} after race condition error`);
                return null;
              }
            } catch (queryErr: any) {
              logger.error(`Failed to query existing SL after race condition for ${symbol}`, formatError(queryErr));
              return null;
            }
        }

        if (!retrying && (error.responseBody?.message?.includes('trigger_price') || error.label === 'INVALID_PARAM_VALUE')) {
            logger.warn(`Invalid SL price for ${symbol}, retrying with fresh market data...`);
            return this.updateStopLoss(symbol, side, price, normalizedText, effectiveAmount || amount, true);
        }

        logHttpError('Failed to update Stop Loss', error, { symbol, side, price, text: normalizedText });

        // 4. Rollback: Try to restore old SLs if New failed
        if (oldSLOrders.length > 0) {
            logger.warn('Rolling back: Restoring original SL orders...');
            for (const oldOrder of oldSLOrders) {
                try {
                    const oldBody = {
                        initial: {
                            contract: oldOrder.initial?.contract || symbol,
                            size: oldOrder.initial?.size || (closeSide === 'buy' ? parseFloat(effectiveAmount || '0') : -parseFloat(effectiveAmount || '0')),
                            price: '0',
                            close: false,
                            // CRITICAL: Must use camelCase `reduceOnly`, NOT snake_case `reduce_only`.
                            // See same comment in updateStopLoss / placeTriggerOrder / placeOrder.
                            reduceOnly: true,
                            tif: oldOrder.initial?.tif || 'ioc',
                            text: oldOrder.initial?.text || 'sl-trigger-rollback'
                        },
                        trigger: {
                            // CRITICAL: Must use camelCase, NOT snake_case (see FuturesPriceTrigger.attributeTypeMap)
                            strategyType: 0,
                            priceType: 0,
                            price: oldOrder.trigger?.price,
                            rule: oldOrder.trigger?.rule ?? rule,
                            expiration: oldOrder.trigger?.expiration || (86400 * 30)
                        }
                    };

                    await this.restClient.createPriceOrder(oldBody);
                    logger.info(`Restored SL ${oldOrder.id} (Price: ${oldOrder.trigger.price})`);
                } catch (rbError: any) {
                    logHttpError(`Failed to rollback/restore SL ${oldOrder.id}`, rbError, {
                        symbol,
                        side,
                        restorePrice: oldOrder.trigger?.price
                    });
                }
            }
        }

        return null;
      }
  }

  public async closePosition(symbol: string, side: 'buy' | 'sell', price?: string, amount?: string, text?: string): Promise<boolean> {
     // To close a position, we place a reduce-only order in opposite direction
     // Use getPositions to handle Hedge Mode correctly
     const positions = await this.getPositions();
     const position = positions.find(p => {
         if (p.symbol !== symbol) return false;
         const size = parseFloat(p.size);
         if (size === 0) return false;
         // If closing via BUY, we need a SHORT position (size < 0)
         if (side === 'buy') return size < 0;
         // If closing via SELL, we need a LONG position (size > 0)
         else return size > 0;
     });

     if (!position || parseFloat(position.size) === 0) return false;

     const currentSize = Math.abs(parseFloat(position.size));
     let sizeToClose = currentSize.toString();

     if (amount) {
       sizeToClose = amount;
       if (parseFloat(amount) > currentSize) {
          logger.warn(`Requested close amount ${amount} exceeds position size ${currentSize} for ${symbol}. Using full size.`);
          sizeToClose = currentSize.toString();
       }
     }

     // If current pos is Long (size>0), we Sell. If Short (size<0), we Buy.
     // Parameter 'side' should match the closing side.
     
     const closeSide = parseFloat(position.size) > 0 ? 'sell' : 'buy';
     
     // Double check intention
     if (side !== closeSide) {
         logger.warn(`Requested close side ${side} does not match position direction for ${symbol}`);
     }

     await this.placeOrder({
         symbol,
         side: closeSide,
         amount: sizeToClose,
         price: price,
         type: price ? 'limit' : 'market',
         reduceOnly: true,
         text: text || 't-close-pos'
     });
     return true;
  }

  // --- Queries ---

  public async getBalance(currency: string = 'USDT'): Promise<AccountBalance> {
    // 重试一次：测试网 getAccount 存在瞬时超时/闪断（实测同 placeOrder 的 stop-match 闪断），
    // 静默返回 total='0' 会令 PositionSizer 走 equity<=0 分支 → 仓位=0 → 订单被误拒（曾致 strategy#950）。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await this.restClient.getAccount();
        return {
          currency: 'USDT',
          available: data.available,
          total: data.total,
          unrealizedPnl: data.unrealisedPnl
        };
      } catch (error: any) {
        if (attempt < 2) {
          logger.warn(`GateIO getBalance transient failure (retry 1/1)`, formatError(error, {
              path: error.path,
              responseBody: error.responseBody
          }));
          await delay(1500);
        } else {
          logger.error('GateIO getBalance failed', formatError(error, {
              path: error.path,
              responseBody: error.responseBody
          }));
          return { currency, available: '0', total: '0' };
        }
      }
    }
    return { currency, available: '0', total: '0' };
  }

  public async getPosition(symbol: string): Promise<Position | null> {
    try {
      /**
       * CRITICAL: 为什么用 listPositions 而不是 getPosition(contract)
       *
       * Gate.io 在 Hedge Mode（双向持仓）下，GET /positions/{contract} 返回数组
       * [{long_position}, {short_position}]，但 gate-api SDK 的 getPosition 声明返回
       * 单个 Position 对象。SDK 反序列化时把数组当对象处理，导致所有字段变成 undefined。
       *
       * 具体流程：
       * 1. API 返回 [{size:'58',...}, {size:'0',...}]
       * 2. SDK ObjectSerializer.deserialize(data, 'Position') — type 不是 'Array<Position>'
       * 3. new Position() → 遍历 attributeTypeMap → data[baseName] → 数组没有字符串属性 → 全 undefined
       * 4. GateIOExchange 检测 size === undefined → 返回 null
       * 5. ProtectionPipeline 查不到持仓 → SL/TP 放置失败 → 裸仓风险
       *
       * 之前的 Array.isArray(data) 检查无效：SDK 已经把数组包装成空 Position 对象，
       * Array.isArray 返回 false，永远走不到 Hedge Mode 处理分支。
       *
       * 另外，SDK 反序列化后字段是 camelCase（entryPrice, markPrice, unrealisedPnl），
       * 但之前的代码用 snake_case 访问（data.entry_price），导致这些字段始终为 undefined。
       * 虽然不影响 SL 放置判断（只看 size 和 contract），但返回的数据不完整。
       *
       * 解决方案：改用 listPositions() + 过滤，listPositions SDK 声明返回 Array<Position>，
       * 反序列化正确。
       *
       * DO NOT "simplify" the filtering below back to `find(contract === symbol)`.
       * Real Gate.io Hedge Mode can return two rows for the same contract: one zero-size
       * leg and one live long/short leg. If we pick the zero-size row first, getPosition()
       * returns null, ProtectionPipeline thinks no position exists, and SL/TP placement is
       * skipped. Always select the non-zero position for this contract.
       */
      const data = await this.restClient.listPositions();
      const matches = data.filter((p: any) => p.contract === symbol);
      const match = matches.find((p: any) => {
        const size = parseFloat(p.size);
        return Number.isFinite(size) && size !== 0;
      });
      if (!match) return null;

      const size = parseFloat(match.size);
      if (!Number.isFinite(size) || size === 0) return null;

      return mapPositionResult(match);
    } catch (error: any) {
       logger.error('GateIO getPosition failed', formatError(error, {
           path: error.path,
           responseBody: error.responseBody
       }));
       return null;
    }
  }

  public async getFinishedOrders(symbol: string, limit: number = 50): Promise<OrderResult[]> {
    try {
      const data = await this.restClient.listOrders({ contract: symbol, status: 'finished', limit });
      return data.map(mapOrderResult);
    } catch (error: any) {
        logger.error('GateIO getFinishedOrders failed', formatError(error, {
            path: error.path,
            responseBody: error.responseBody
        }));
        return [];
    }
  }

  public async getOrder(orderId: string, symbol: string): Promise<OrderResult> {
    try {
      const data = await this.restClient.getOrder(symbol, orderId);
      return mapOrderResult(data);
    } catch (error: any) {
       logger.error('GateIO getOrder failed', formatError(error, {
           path: error.path,
           responseBody: error.responseBody
       }));
       throw error;
    }
  }

  public async getPositions(): Promise<Position[]> {
    try {
      const data = await this.restClient.listPositions();
      return data.map(mapPositionResult);
    } catch (error: any) {
       logger.error('GateIO getPositions failed', formatError(error, {
           path: error.path,
           responseBody: error.responseBody
       }));
       return [];
    }
  }

  public async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    try {
      const orders = await this.restClient.listOrders({ status: 'open' });
      let results = orders;
      if (symbol) {
          results = orders.filter((o: any) => o.contract === symbol);
      }
      return results.map(mapOpenOrderResult);
    } catch (error: any) {
      logger.error('GateIO getOpenOrders failed', formatError(error, {
          path: error.path,
          responseBody: error.responseBody
      }));
      return [];
    }
  }



  public async getPriceOrders(symbol?: string): Promise<OrderResult[]> {
    try {
      let orders = await this.restClient.listPriceOrders({ status: 'open' });
      if (symbol) {
          orders = orders.filter((o: any) => o.initial.contract === symbol);
      }
      if (orders.length > 0 && symbol) {
        logger.debug(`[getPriceOrders] ${orders.length} orders for ${symbol}`);
      }
      return orders.map(mapPriceOrderResult);
    } catch (error: any) {
        logger.error('GateIO getPriceOrders failed', formatError(error, {
            path: error.path,
            responseBody: error.responseBody
        }));
        throw error;
    }
  }

  public async cancelAllPriceOrders(symbol: string): Promise<void> {
    try {
        await this.restClient.cancelAllPriceOrders(symbol);
        logger.info(`Cancelled all price orders for ${symbol}`);
    } catch (error: any) {
        logger.error('GateIO cancelAllPriceOrders failed', formatError(error, {
            path: error.path,
            responseBody: error.responseBody
        }));
        throw error;
    }
  }

  public async getTradeHistory(symbol: string, limit: number = 50): Promise<Trade[]> {
    try {
      const data = await this.restClient.listTrades(symbol, limit);
      return data.map(mapTradeResult);
    } catch (error: any) {
       logger.error('GateIO getTradeHistory failed', formatError(error, {
           path: error.path,
           responseBody: error.responseBody
       }));
       return [];
    }
  }

  // --- Helpers ---

  private async ensureMarketsLoaded(force: boolean = false): Promise<void> {
    if (this.markets.size === 0 || force) {
      try {
        const markets = await this.getMarkets(force);
        for (const m of markets) {
          this.markets.set(m.symbol, m);
        }
      } catch (error) {
        logger.error('Failed to load markets for price formatting', { error });
      }
    }
  }

  private async formatPrice(symbol: string, price: string | number, forceRefresh: boolean = false): Promise<string> {
    await this.ensureMarketsLoaded(forceRefresh);
    const market = this.markets.get(symbol);
    if (!market) {
        return price.toString();
    }
    return formatPriceWithMarket(market, price);
  }

  // --- Queries ---

  public async getMarkets(forceRefresh: boolean = false): Promise<MarketInfo[]> {
    const CACHE_FILE = path.join(process.cwd(), 'data', 'gateio_markets.json');
    const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

    // 1. Try Load from Cache
    if (!forceRefresh) {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const stat = fs.statSync(CACHE_FILE);
                if (Date.now() - stat.mtimeMs < CACHE_DURATION) {
                    const cachedData = fs.readFileSync(CACHE_FILE, 'utf-8');
                    const markets = JSON.parse(cachedData);
                    
                    // Validate cache has tickSize (since we recently added it)
                    if (markets.length > 0 && markets[0].tickSize === undefined) {
                        logger.warn('Market cache outdated (missing tickSize), forcing refresh');
                        throw new Error('Cache outdated');
                    }

                    // Completeness check: cache should have at least 50 markets
                    if (markets.length < 50) {
                        logger.warn(`Market cache incomplete (${markets.length} markets, need >= 50), forcing refresh`);
                        throw new Error('Cache incomplete');
                    }

                    logger.info('Loaded markets from cache');
                    // Populate internal map
                    for (const m of markets) {
                        this.markets.set(m.symbol, m);
                    }
                    return markets;
                }
            }
        } catch (err) {
            logger.warn('Failed to load market cache (will fetch fresh)', { error: err });
        }
    }


    // 2. Fetch from API
    try {
      const contracts = await this.restClient.listContracts();

      const markets = contracts.map(mapContractToMarketInfo);

      if (markets.length < 10) {
        logger.warn(`GateIO API returned only ${markets.length} markets, falling back to dict file`);
        const dictMarkets = loadMarketsFromDict();
        if (dictMarkets.length > markets.length) {
          for (const m of dictMarkets) {
            this.markets.set(m.symbol, m);
          }
          return dictMarkets;
        }
        // Don't save incomplete results to file cache, but populate in-memory map
        for (const m of markets) {
          this.markets.set(m.symbol, m);
        }
        return markets;
      }

      // 3. Save to Cache
      try {
          const dir = path.dirname(CACHE_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(CACHE_FILE, JSON.stringify(markets, null, 2));
          logger.info('Saved markets to cache');
      } catch (err) {
          logger.warn('Failed to save market cache', { error: err });
      }

      return markets;
    } catch (error: any) {
       logger.error('GateIO getMarkets failed', formatError(error, {
           path: error.path,
           responseBody: error.responseBody
       }));

       // Fallback 1: try dict file
       const dictMarkets = loadMarketsFromDict();
       if (dictMarkets.length > 0) {
           logger.warn('GateIO getMarkets API failed, using dict file as fallback');
           for (const m of dictMarkets) {
               this.markets.set(m.symbol, m);
           }
           return dictMarkets;
       }

       // Fallback 2: try stale cache
       try {
           if (fs.existsSync(CACHE_FILE)) {
               const cachedData = fs.readFileSync(CACHE_FILE, 'utf-8');
               const markets = JSON.parse(cachedData);
               if (Array.isArray(markets) && markets.length > 0) {
                   if (markets.length < 50) {
                       logger.warn(`Stale cache also incomplete (${markets.length} markets), but using as last resort`);
                   }
                   logger.warn('GateIO getMarkets API failed, dict file failed, using stale cache as fallback');
                   for (const m of markets) {
                       this.markets.set(m.symbol, m);
                   }
                   return markets;
               }
           }
       } catch (cacheErr) {
           logger.warn('GateIO getMarkets stale cache fallback also failed', { error: cacheErr });
       }

       return [];
    }
  }

  public async getTicker(symbol: string): Promise<Ticker> {
     try {
       const data = (await this.restClient.listTickers(symbol))[0];
       return mapTickerResult(data);
     } catch (error: any) {
        logger.error('GateIO getTicker failed', formatError(error));
        throw error;
     }
   }

  public async getCandles(symbol: string, timeframe: string, limit: number = 2): Promise<Candle[]> {
     const interval = toGateCandleInterval(timeframe);
     const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit || 2)));

     try {
       const rows = await this.restClient.listCandlesticks(symbol, interval, safeLimit);
       return rows
         .map(mapCandleRow)
         .filter((c: Candle) => Number.isFinite(c.timestamp) && Number.isFinite(Number(c.close)));
     } catch (error: any) {
        logger.error('GateIO getCandles failed', formatError(error, { symbol, timeframe }));
        throw error;
     }
   }

   public async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', leverage: string = '10'): Promise<boolean> {
    // In Gate.io Futures V4:
    // Leverage = 0 means Cross Margin.
    // Leverage > 0 means Isolated Margin.

    try {
        let targetLeverage = leverage;
        if (marginMode === 'cross') {
            targetLeverage = '0';
        } else {
            // Isolated: ensure leverage is not 0. Default to 10 if user passed 0 by mistake or didn't provide it.
            if (targetLeverage === '0') targetLeverage = '10';
        }

        logger.info(`Setting margin mode to ${marginMode} via leverage ${targetLeverage} for ${symbol}`);
        await this.setLeverage(symbol, targetLeverage);

        return true;

    } catch (error: any) {
        logger.error('GateIO setMarginMode failed', formatError(error));
        throw error;
    }
  }

  public async getMarginMode(symbol: string): Promise<{ marginMode: 'cross' | 'isolated', leverage: string }> {
      // Re-use getPosition logic as it contains the info
      const position = await this.getPosition(symbol);
      if (position) {
          return {
              marginMode: position.marginType,
              leverage: position.leverage
          };
      }
      
      return { marginMode: 'isolated', leverage: '0' }; // Unknown default
  }

  public async setLeverage(symbol: string, leverage: string): Promise<boolean> {
    try {
      await this.restClient.updateLeverage(symbol, leverage);
      logger.info(`Set leverage for ${symbol}: ${leverage}x`);
      return true;
    } catch (error: any) {
      logHttpError('GateIO setLeverage failed', error, { symbol, leverage });
      throw error;
    }
  }

  public getWebSocketStats() {
      return this.ws.getStats();
  }
}
