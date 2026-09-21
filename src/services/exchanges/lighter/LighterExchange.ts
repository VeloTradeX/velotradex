import {
  AccountBalance,
  Candle,
  ExchangeConfig,
  IExchange,
  MarketInfo,
  OrderParams,
  OrderResult,
  Position,
  Ticker,
  Trade,
} from '../IExchange';
import { EventEmitter } from 'events';
import appConfig from '../../../config';
import LighterClientOrderIndex from '../../../models/LighterClientOrderIndex';
import LighterTxJournal from '../../../models/LighterTxJournal';
import PendingProtection from '../../../models/PendingProtection';
import logger, { formatError } from '../../../utils/logger';
import { LighterClientOrderIndexStore } from './LighterClientOrderIndexStore';
import { LighterMarketMap } from './LighterMarketMap';
import { LighterOrderPersistenceHandler } from './LighterOrderPersistenceHandler';
import { ProtectionPipeline } from '../../ProtectionPipeline';
import { LighterNonceManager, LighterSubmitResult } from './LighterNonceManager';
import { LighterRestTxClient } from './LighterRestTxClient';
import { LighterSignerBridge } from './LighterSignerBridge';
import { LighterStateReconciler } from './LighterStateReconciler';
import { LighterWsStateClient } from './LighterWsStateClient';
import { LighterTxIntent } from './types';
import {
  normalizeLighterBalance,
  normalizeLighterCandles,
  normalizeLighterTicker,
  normalizeLighterTrades,
} from './LighterResponseNormalizer';
import { NormalizedLighterExchangeConfig, normalizeConfig } from './LighterConfigNormalizer';
import { normalizeOrders } from './LighterOrderMapper';
import { calculateMaxOpenAmount, isPositiveDecimalString } from './LighterOrderMath';
import { extractPositionRows, enrichPositionRow } from './LighterPositionMapper';
import { buildBusinessKey, buildIntent } from './LighterRequestBuilder';

type LighterOrderParams = OrderParams & {
  lighterOrderType?: 'STOP_LOSS' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT' | 'TAKE_PROFIT_LIMIT';
  /** 开仓保证金计算上下文，由 TradeExecutor 传入，避免 placeOrder 内部重复 REST 调用 */
  marginContext?: {
    leverage: number;
    availableBalance: number;
    position: Position | null;
  };
};

export interface LighterExchangeDeps {
  marketMap?: LighterMarketMap;
  clientOrderIndexStore?: {
    getOrCreate(exchangeInstanceId: string, businessKey: string): Promise<string>;
  };
  signer?: {
    assertUsable(): Promise<void>;
    createAuthToken?(): Promise<{ token: string; expiresAt: string | number | Date }>;
  };
  restClient?: {
    getNextNonce?(accountIndex: number, apiKeyIndex: number): Promise<string>;
    sendTx?(txType: number, txInfo: string): Promise<unknown>;
    getAccountPositions(accountIndex: number): Promise<unknown>;
    getAccount?(accountIndex: number): Promise<unknown>;
    getAccountOrders?(accountIndex: number): Promise<unknown>;
    getAccountOrderHistory?(accountIndex: number, marketIndex: number, limit?: number): Promise<unknown>;
    getAccountTrades?(accountIndex: number, marketIndex: number, limit?: number): Promise<unknown>;
    getTicker?(marketIndex: number): Promise<unknown>;
    getCandles?(marketId: number, resolution: string, countBack: number, startTimestamp: number, endTimestamp: number): Promise<unknown>;
    getAccountTx?(accountIndex: number, value: string, by?: string): Promise<unknown>;
  };
  nonceManager?: {
    submit(intent: LighterTxIntent): Promise<LighterSubmitResult>;
  };
  reconciler?: {
    reconcileStartup(exchangeInstanceId: string): Promise<{ safeToTrade: boolean; unknownTxCount: number }>;
    waitForFill(clientOrderIndex: string, symbol: string, timeoutMs?: number): Promise<OrderResult>;
    normalizePosition(position: unknown): Position;
  };
  wsClient?: {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getStats(): unknown;
    on?(event: 'order' | 'position' | string, handler: (event: unknown) => void): unknown;
  };
}

export class LighterExchange extends EventEmitter implements IExchange {
  public readonly id: string;
  public readonly name: string;

  private readonly config: NormalizedLighterExchangeConfig;
  private readonly marketMap: LighterMarketMap;
  private readonly clientOrderIndexStore: NonNullable<LighterExchangeDeps['clientOrderIndexStore']>;
  private readonly signer: NonNullable<LighterExchangeDeps['signer']>;
  private readonly restClient: NonNullable<LighterExchangeDeps['restClient']>;
  private readonly nonceManager: NonNullable<LighterExchangeDeps['nonceManager']>;
  private readonly reconciler: NonNullable<LighterExchangeDeps['reconciler']>;
  private readonly wsClient: NonNullable<LighterExchangeDeps['wsClient']>;
  private readonly orderPersistenceHandler: LighterOrderPersistenceHandler;
  private safeToTrade = false;
  private pausedReason: string | null = null;

  constructor(config: ExchangeConfig, deps: LighterExchangeDeps = {}) {
    super();
    this.config = normalizeConfig(config);
    this.id = config.id;
    this.name = config.name;

    this.marketMap = deps.marketMap ?? new LighterMarketMap({ markets: this.config.markets });
    this.clientOrderIndexStore = deps.clientOrderIndexStore
      ?? new LighterClientOrderIndexStore(LighterClientOrderIndex);

    const signer = deps.signer ?? new LighterSignerBridge(this.config.signerPath, {
      apiPrivateKey: this.config.privateKey,
      baseURL: this.config.baseURL ?? appConfig.external.urls.lighterMainnet,
      accountIndex: this.config.accountIndex,
      apiKeyIndex: this.config.apiKeyIndex,
    });
    const restClient = deps.restClient
      ?? new LighterRestTxClient(
        this.config.baseURL ?? appConfig.external.urls.lighterMainnet,
        this.config.proxy,
        async () => {
          if (typeof signer.createAuthToken !== 'function') {
            throw new Error('Lighter signer does not support REST auth token generation');
          }
          return (await signer.createAuthToken()).token;
        },
      );

    this.signer = signer;
    this.restClient = restClient;
    this.reconciler = deps.reconciler
      ?? new LighterStateReconciler({
        journalModel: LighterTxJournal,
        lookupOrder: async (clientOrderIndex, symbol) => this.getOrder(clientOrderIndex, symbol),
        lookupTx: async (identifier, identifierType) => {
          const by = identifierType === 'nonce' ? 'sequence_index' : 'tx_info_hash';
          return this.restClient.getAccountTx?.(this.config.accountIndex, identifier, by);
        },
      });
    this.nonceManager = deps.nonceManager
      ?? new LighterNonceManager({
        exchangeInstanceId: this.config.exchangeInstanceId,
        accountIndex: this.config.accountIndex,
        apiKeyIndex: this.config.apiKeyIndex,
        signer: signer as unknown as { sign(intent: LighterTxIntent & { nonce: string }): Promise<any> },
        restClient: restClient as {
          getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<string>;
          sendTx(txType: number, txInfo: string): Promise<any>;
        },
      });
    this.wsClient = deps.wsClient
      ?? new LighterWsStateClient(
        this.config.wsURL ?? 'wss://mainnet.zklighter.elliot.ai/stream',
        this.config.accountIndex,
        () => {
          if (typeof signer.createAuthToken !== 'function') {
            throw new Error('Lighter signer does not support WS auth token generation');
          }
          return signer.createAuthToken();
        },
        this.config.proxy,
      );

    this.wsClient.on?.('order', event => {
      if (typeof (this.reconciler as any).handleOrderEvent === 'function') {
        (this.reconciler as any).handleOrderEvent(event);
      }
    });
    this.wsClient.on?.('tx', event => {
      if (typeof (this.reconciler as any).handleTxEvent === 'function') {
        (this.reconciler as any).handleTxEvent(event);
      }
    });
    this.wsClient.on?.('connected', () => {
      this.emit('wsConnected');
    });
    this.wsClient.on?.('disconnected', () => {
      this.emit('disconnected');
    });
    this.wsClient.on?.('accountUpdate', (msg: any) => {
      logger.debug(`[Lighter] accountUpdate: orders=${msg.orders?.length ?? 0}, positions=${Array.isArray(msg.positions) ? msg.positions.length : Object.keys(msg.positions || {}).length}, trades=${msg.trades?.length ?? 0}`);
    });

    // Wire order persistence handler for SL/TP lifecycle management
    this.orderPersistenceHandler = new LighterOrderPersistenceHandler(this.reconciler as any, this);
  }

  public setProtectionPipeline(pipeline: ProtectionPipeline): void {
    this.orderPersistenceHandler.setProtectionPipeline(pipeline);
  }

  async testConnection(): Promise<{ success: boolean; http: boolean; ws: boolean; message: string }> {
    await this.signer.assertUsable();
    await this.restClient.getAccount?.(this.config.accountIndex);
    if (typeof this.signer.createAuthToken !== 'function') {
      throw new Error('Lighter signer does not support WS auth token generation');
    }
    await this.signer.createAuthToken();
    return {
      success: true,
      http: true,
      ws: true,
      message: 'Lighter connection check passed',
    };
  }

  async start(): Promise<void> {
    this.safeToTrade = false;
    this.pausedReason = null;
    await this.signer.assertUsable();
    await this.wsClient.connect();
    try {
      const reconciliation = await this.reconciler.reconcileStartup(this.id);
      this.safeToTrade = reconciliation.safeToTrade;

      if (!this.safeToTrade) {
        this.pausedReason = `Lighter exchange ${this.id} has ${reconciliation.unknownTxCount} unknown txs; trading paused`;
        logger.warn(this.pausedReason);
      }
    } catch (error) {
      this.safeToTrade = false;
      this.pausedReason = error instanceof Error ? error.message : String(error);
      await this.wsClient.disconnect();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.safeToTrade = false;
    this.pausedReason = null;
    await this.wsClient.disconnect();
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(params.symbol);
    const resolvedSymbol = market.symbol;
    const orderType = params.type ?? 'limit';
    const lighterOrderType = (params as LighterOrderParams).lighterOrderType ?? orderType;
    let price = params.price;

    if (orderType === 'limit' && (typeof price !== 'string' || price.length === 0)) {
      throw new Error(`Lighter limit order requires price for ${params.symbol}`);
    }
    if (orderType === 'market' && (typeof price !== 'string' || price.length === 0)) {
      price = await this.calculateWorstAcceptablePrice(params.symbol, params.side);
    }
    if (typeof price !== 'string' || price.length === 0) {
      throw new Error(`Lighter order requires price for ${params.symbol}`);
    }

    const clientOrderIndex = await this.clientOrderIndexStore.getOrCreate(
      this.config.exchangeInstanceId,
      params.text ?? buildBusinessKey(params),
    );
    const integerAmount = this.marketMap.toIntegerSize(params.symbol, params.amount);
    let integerPrice = this.marketMap.toIntegerPrice(params.symbol, price);

    // For STOP_LOSS orders, calculate execution price with configurable slippage buffer
    let executionPrice: string | undefined;
    if (lighterOrderType === 'STOP_LOSS' && params.triggerPrice) {
      const triggerPriceNum = parseFloat(params.triggerPrice);
      const slippagePercent = this.config.defaultSlippageBps / 10000; // bps to decimal
      const slippageFactor = params.side === 'buy' ? (1 + slippagePercent) : (1 - slippagePercent);
      const execPriceNum = triggerPriceNum * slippageFactor;
      executionPrice = execPriceNum.toFixed(market.priceDecimals);
      integerPrice = this.marketMap.toIntegerPrice(params.symbol, executionPrice);
    }

    // For TAKE_PROFIT_LIMIT orders, trigger_price = execution_price (no extra slippage)
    if (lighterOrderType === 'TAKE_PROFIT_LIMIT' && params.triggerPrice) {
      executionPrice = params.triggerPrice;
      integerPrice = this.marketMap.toIntegerPrice(params.symbol, executionPrice);
    }

    // Persist PendingProtection BEFORE placing the order. Lighter clientOrderIndex is
    // deterministic per business key, so retries must refresh stale CLAIMED/FAILED rows.
    let pendingProtectionPersisted = false;
    if (params.stopLoss || params.takeProfit) {
      try {
        await PendingProtection.upsert({
          orderId: clientOrderIndex,
          symbol: resolvedSymbol,
          side: params.side,
          stopLoss: params.stopLoss || null,
          takeProfit: params.takeProfit || null,
          tpOrdersJson: params.tpOrders ? JSON.stringify(params.tpOrders) : null,
          status: 'PENDING',
        });
        pendingProtectionPersisted = true;
      } catch (dbErr) {
        logger.error(`Failed to persist pending protection for ${clientOrderIndex}`, { error: dbErr });
        throw new Error(`Failed to persist pending protection before placing Lighter order ${clientOrderIndex}`);
      }
    }

    try {
      let adjustedAmount = params.amount;
      let adjustedIntegerAmount = integerAmount;

      // 减仓订单不需要保证金，跳过调整
      if (!params.reduceOnly) {
        const ctx = (params as LighterOrderParams).marginContext;
        if (ctx && Number.isFinite(ctx.leverage) && ctx.leverage > 0 && Number.isFinite(ctx.availableBalance) && ctx.availableBalance > 0) {
          const maxOpenAmount = calculateMaxOpenAmount(this.marketMap, resolvedSymbol, params.side, price, ctx.leverage, ctx.availableBalance, ctx.position);
          const maxOpenAmountNum = parseFloat(maxOpenAmount);
          const requestedAmountNum = parseFloat(params.amount);

          if (maxOpenAmountNum > 0 && requestedAmountNum > maxOpenAmountNum) {
            adjustedAmount = maxOpenAmount;
            adjustedIntegerAmount = this.marketMap.toIntegerSize(resolvedSymbol, adjustedAmount);

            const ratio = maxOpenAmountNum / requestedAmountNum;
            logger.info(`[Lighter] Order amount adjusted due to margin constraints: requested=${params.amount}, max available=${adjustedAmount} (${(ratio * 100).toFixed(1)}% of requested)`);

            if (parseFloat(adjustedAmount) <= 0) {
              throw new Error(`Lighter order amount adjusted to zero, insufficient margin for ${resolvedSymbol}`);
            }
          }
        } else {
          logger.debug(`[Lighter] No marginContext provided, skipping margin-based amount adjustment for ${resolvedSymbol}`);
        }
      }

      const intent = buildIntent('place_order', {
        symbol: resolvedSymbol,
        marketIndex: market.marketIndex,
        side: params.side,
        price,
        amount: adjustedAmount,
        clientOrderIndex,
        reduceOnly: params.reduceOnly ?? false,
        postOnly: params.postOnly ?? false,
        triggerPrice: params.triggerPrice,
        payload: {
          market_index: market.marketIndex,
          client_order_index: clientOrderIndex,
          is_ask: params.side === 'sell',
          base_amount: adjustedIntegerAmount,
          price: integerPrice,
          order_type: lighterOrderType,
          reduce_only: params.reduceOnly ?? false,
          post_only: params.postOnly ?? false,
          trigger_price: params.triggerPrice
            ? this.marketMap.toIntegerPrice(params.symbol, params.triggerPrice)
            : undefined,
        },
      });

      logger.info(`[Lighter] Submitting order: symbol=${resolvedSymbol}, side=${params.side}, type=${lighterOrderType}, ` +
        `price=${price} (int=${integerPrice}), amount=${adjustedAmount} (int=${adjustedIntegerAmount}), ` +
        `postOnly=${params.postOnly ?? false}, reduceOnly=${params.reduceOnly ?? false}`);

      const raw = await this.nonceManager.submit(intent);

      if (raw.error) {
        const errorMsg = raw.error.toLowerCase();
        if (errorMsg.includes('not enough margin') || errorMsg.includes('insufficient margin') || errorMsg.includes('margin不足')) {
          logger.warn(`[Lighter] Order still failed with margin error after adjustment: requested=${params.amount}, adjusted=${adjustedAmount}`);
        }
        throw new Error(`Lighter sendTx rejected for ${clientOrderIndex}: ${raw.error}`);
      }

      return {
        id: clientOrderIndex,
        status: 'accepted',
        amount: adjustedAmount,
        price,
        raw: raw.raw,
      };
    } catch (err) {
      if (pendingProtectionPersisted) {
        try {
          await PendingProtection.destroy({ where: { orderId: clientOrderIndex } });
        } catch (cleanupErr) {
          logger.error(`Failed to cleanup pending protection for ${clientOrderIndex}`, { error: cleanupErr });
        }
      }
      throw err;
    }
  }

  async amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(symbol);
    const existing = await this.getOrder(orderId, symbol);

    const mergedPrice = price ?? existing.price;
    const mergedAmount = amount ?? existing.amount;

    if (typeof mergedPrice !== 'string' || mergedPrice.length === 0) {
      throw new Error(`Lighter amendOrder requires price for ${symbol}`);
    }
    if (typeof mergedAmount !== 'string' || mergedAmount.length === 0) {
      throw new Error(`Lighter amendOrder requires amount for ${symbol}`);
    }

    const integerAmount = this.marketMap.toIntegerSize(symbol, mergedAmount);
    const integerPrice = this.marketMap.toIntegerPrice(symbol, mergedPrice);

    const intent = buildIntent('amend_order', {
      symbol,
      marketIndex: market.marketIndex,
      clientOrderIndex: orderId,
      price: mergedPrice,
      amount: mergedAmount,
      payload: {
        market_index: market.marketIndex,
        order_index: orderId,
        base_amount: integerAmount,
        price: integerPrice,
      },
    });
    const raw = await this.nonceManager.submit(intent);

    return {
      id: orderId,
      status: 'accepted',
      amount: mergedAmount,
      price: mergedPrice,
      raw: raw.raw,
    };
  }

  async placeOtocoOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    amount: string;
    entryPrice: string;
    slTrigger: string;
    slExec: string;
    tpPrice: string;
    orderId: string;
    marginContext?: LighterOrderParams['marginContext'];
  }): Promise<{ mainOrderId: string; slOrderId: string; tpOrderId: string }> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(params.symbol);
    const isAsk = params.side === 'sell';
    const closeIsAsk = !isAsk;

    // Get base client_order_index
    const baseClientOrderIndex = await this.clientOrderIndexStore.getOrCreate(
      this.config.exchangeInstanceId,
      `otoco-${params.orderId}`,
    );

    // Convert to Lighter integers
    let baseAmount = this.marketMap.toIntegerSize(params.symbol, params.amount);
    const entryPrice = this.marketMap.toIntegerPrice(params.symbol, params.entryPrice);
    const slTriggerPrice = this.marketMap.toIntegerPrice(params.symbol, params.slTrigger);
    const slExecPrice = this.marketMap.toIntegerPrice(params.symbol, params.slExec);
    const tpPrice = this.marketMap.toIntegerPrice(params.symbol, params.tpPrice);

    // OTOCO 始终是开仓单，计算保证金调整
    let adjustedAmount = params.amount;
    const ctx = params.marginContext;
    if (ctx && Number.isFinite(ctx.leverage) && ctx.leverage > 0 && Number.isFinite(ctx.availableBalance) && ctx.availableBalance > 0) {
      const maxOpenAmount = calculateMaxOpenAmount(this.marketMap, params.symbol, params.side, params.entryPrice, ctx.leverage, ctx.availableBalance, ctx.position);
      const maxOpenAmountNum = parseFloat(maxOpenAmount);
      const requestedAmountNum = parseFloat(params.amount);

      if (maxOpenAmountNum > 0 && requestedAmountNum > maxOpenAmountNum) {
        adjustedAmount = maxOpenAmount;
        baseAmount = this.marketMap.toIntegerSize(params.symbol, adjustedAmount);

        const ratio = maxOpenAmountNum / requestedAmountNum;
        logger.info(`[Lighter] OTOCO order amount adjusted due to margin constraints: requested=${params.amount}, max available=${adjustedAmount} (${(ratio * 100).toFixed(1)}% of requested)`);

        if (parseFloat(adjustedAmount) <= 0) {
          throw new Error(`Lighter OTOCO order amount adjusted to zero, insufficient margin for ${params.symbol}`);
        }
      }
    } else {
      logger.debug(`[Lighter] No marginContext provided, skipping margin-based amount adjustment for OTOCO ${params.symbol}`);
    }

    const orders = [
      // Main order (limit)
      {
        market_index: market.marketIndex,
        client_order_index: baseClientOrderIndex,
        base_amount: baseAmount,
        price: entryPrice,
        is_ask: isAsk,
        order_type: 'limit',
        post_only: false,
        reduce_only: false,
        trigger_price: 0,
      },
      // Stop loss
      {
        market_index: market.marketIndex,
        client_order_index: baseClientOrderIndex + 1,
        base_amount: 0, // 0 = follow main order filled amount
        price: slExecPrice,
        is_ask: closeIsAsk,
        order_type: 'stop_loss_limit',
        post_only: false,
        reduce_only: true,
        trigger_price: slTriggerPrice,
      },
      // Take profit
      {
        market_index: market.marketIndex,
        client_order_index: baseClientOrderIndex + 2,
        base_amount: 0, // 0 = follow main order filled amount
        price: tpPrice,
        is_ask: closeIsAsk,
        order_type: 'take_profit_limit',
        post_only: false,
        reduce_only: true,
        trigger_price: tpPrice,
      },
    ];

    const intent = buildIntent('create_grouped_orders', {
      symbol: params.symbol,
      marketIndex: market.marketIndex,
      side: params.side,
      payload: {
        grouping_type: 3, // ONE_TRIGGERS_A_ONE_CANCELS_THE_OTHER
        orders,
      },
    });

    logger.info(`[Lighter] Submitting OTOCO order: symbol=${params.symbol}, side=${params.side}, ` +
      `entry=${params.entryPrice}, sl=${params.slTrigger}/${params.slExec}, tp=${params.tpPrice}, amount=${adjustedAmount}`);

    const raw = await this.nonceManager.submit(intent);

    if (raw.error) {
      // 如果仍然是保证金错误，记录警告
      const errorMsg = raw.error.toLowerCase();
      if (errorMsg.includes('not enough margin') || errorMsg.includes('insufficient margin') || errorMsg.includes('margin不足')) {
        logger.warn(`[Lighter] OTOCO order still failed with margin error after adjustment: requested=${params.amount}, adjusted=${adjustedAmount}`);
      }
      throw new Error(`Lighter OTOCO order rejected: ${raw.error}`);
    }

    return {
      mainOrderId: baseClientOrderIndex.toString(),
      slOrderId: (baseClientOrderIndex + 1).toString(),
      tpOrderId: (baseClientOrderIndex + 2).toString(),
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    return this.cancelPriceOrder(orderId, symbol);
  }

  async cancelPriceOrder(orderId: string, symbol: string): Promise<boolean> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(symbol);
    await this.nonceManager.submit(buildIntent('cancel_order', {
      symbol,
      marketIndex: market.marketIndex,
      clientOrderIndex: orderId,
      payload: {
        market_index: market.marketIndex,
        client_order_index: orderId,
      },
    }));
    return true;
  }

  async updateStopLoss(
    symbol: string,
    side: 'buy' | 'sell',
    price: string,
    text?: string,
    amount?: string,
  ): Promise<string | null> {
    // Resolve amount: use provided amount, or fallback to position size
    let effectiveAmount = amount;
    if (!isPositiveDecimalString(effectiveAmount)) {
      try {
        const position = await this.getPosition(symbol);
        effectiveAmount = position?.size;
      } catch {
        // ignore
      }
      if (!isPositiveDecimalString(effectiveAmount)) {
        throw new Error('Lighter updateStopLoss requires positive amount (not available from params or position)');
      }
    }

    logger.info(`[Lighter] updateStopLoss: symbol=${symbol}, side=${side}, price=${price}, amount=${effectiveAmount}, text=${text}`);

    // Query existing SL orders for this symbol+side
    const existingSlOrders: Array<{ id: string; price?: string; amount?: string }> = [];
    try {
      const priceOrders = await this.getPriceOrders(symbol);
      const closeSide = side === 'buy' ? 'sell' : 'buy';
      for (const order of priceOrders) {
        const orderType = (order.type ?? '').toUpperCase();
        const isSl = orderType === 'STOP_LOSS' || orderType === 'STOP_LOSS_LIMIT';
        if (isSl && order.side === closeSide) {
          existingSlOrders.push({ id: order.id, price: order.price, amount: order.amount });
        }
      }
    } catch {
      // If query fails, proceed without canceling old SLs
    }

    // Cancel existing SL orders
    for (const oldSl of existingSlOrders) {
      try {
        await this.cancelOrder(oldSl.id, symbol);
      } catch {
        // Best effort cancellation
      }
    }

    // Place new SL with configurable slippage
    // For STOP_LOSS: trigger_price = price, execution_price = price * slippage_factor
    // Long SL (sell): execution_price = trigger_price * (1 - slippage%)
    // Short SL (buy): execution_price = trigger_price * (1 + slippage%)
    try {
      const uniqueText = text ? `${text}-${Date.now()}` : undefined;
      const market = this.marketMap.resolve(symbol);
      const triggerPrice = parseFloat(price).toFixed(market.priceDecimals);
      const triggerPriceNum = parseFloat(triggerPrice);
      const slippagePercent = this.config.defaultSlippageBps / 10000; // bps to decimal
      const slippageFactor = side === 'buy' ? (1 - slippagePercent) : (1 + slippagePercent);
      const executionPriceNum = triggerPriceNum * slippageFactor;
      const executionPrice = executionPriceNum.toFixed(market.priceDecimals);

      const result = await this.placeOrder({
        symbol,
        side: side === 'buy' ? 'sell' : 'buy',
        amount: effectiveAmount,
        price: executionPrice,
        type: 'market',
        text: uniqueText,
        triggerPrice,
        reduceOnly: true,
        lighterOrderType: 'STOP_LOSS',
      } as LighterOrderParams);
      return result.id;
    } catch (err) {
      // Rollback: attempt to restore old SL orders
      for (const oldSl of existingSlOrders) {
        try {
          const oldTriggerRaw = oldSl.price || price;
          const market = this.marketMap.resolve(symbol);
          const oldTriggerPrice = parseFloat(oldTriggerRaw).toFixed(market.priceDecimals);
          const oldTriggerPriceNum = parseFloat(oldTriggerPrice);
          const slippagePercent = this.config.defaultSlippageBps / 10000; // bps to decimal
          const slippageFactor = side === 'buy' ? (1 - slippagePercent) : (1 + slippagePercent);
          const oldExecutionPriceNum = oldTriggerPriceNum * slippageFactor;
          const oldExecutionPrice = oldExecutionPriceNum.toFixed(market.priceDecimals);

          await this.placeOrder({
            symbol,
            side: side === 'buy' ? 'sell' : 'buy',
            amount: oldSl.amount || effectiveAmount,
            price: oldExecutionPrice,
            type: 'market',
            triggerPrice: oldTriggerPrice,
            reduceOnly: true,
            lighterOrderType: 'STOP_LOSS',
          } as LighterOrderParams);
        } catch {
          // Rollback also failed
        }
      }
      throw err;
    }
  }

  async closePosition(symbol: string, side: 'buy' | 'sell', price?: string, amount?: string, _text?: string): Promise<boolean> {
    this.assertSafeToTrade();

    const resolvedAmount = amount ?? await this.getClosablePositionAmount(symbol);
    if (resolvedAmount === '0') {
      return false;
    }

    await this.placeOrder({
      symbol,
      side,
      amount: resolvedAmount,
      price,
      type: price ? 'limit' : 'market',
      reduceOnly: true,
    });
    return true;
  }

  async getBalance(currency?: string): Promise<AccountBalance> {
    const raw = await this.restClient.getAccount!(this.config.accountIndex);
    return normalizeLighterBalance(raw, currency ?? this.config.balanceCurrency);
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const resolvedSymbol = this.marketMap.resolve(symbol).symbol;
    const positions = await this.getPositions();
    const match = positions.find(position => position.symbol === resolvedSymbol) ?? null;
    if (!match) {
      logger.warn(`[LighterExchange] getPosition(${symbol}): no match. Available: [${positions.map(p => `${p.symbol}(size=${p.size})`).join(', ')}]`);
    }
    return match;
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.restClient.getAccountPositions(this.config.accountIndex);
    const rows = extractPositionRows(raw, this.config.markets);
    logger.debug(`[LighterExchange] getPositions: ${rows.length} raw rows extracted`);

    return rows.map(position => this.reconciler.normalizePosition(enrichPositionRow(position, this.config.markets)));
  }

  async getOrder(orderId: string, symbol: string): Promise<OrderResult> {
    const market = this.marketMap.resolve(symbol);

    const activeRaw = await this.restClient.getAccountOrders!(this.config.accountIndex);
    const activeOrders = normalizeOrders(activeRaw, this.config.markets, symbol);
    const activeMatch = activeOrders.find(o => o.id === orderId);
    if (activeMatch) return activeMatch;

    const historyRaw = await this.restClient.getAccountOrderHistory!(
      this.config.accountIndex,
      market.marketIndex,
    );
    const historyOrders = normalizeOrders(historyRaw, this.config.markets, symbol);
    const historyMatch = historyOrders.find(o => o.id === orderId);
    if (historyMatch) return historyMatch;

    throw new Error(`Lighter order not found: ${orderId} ${symbol}`);
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const raw = await this.restClient.getAccountOrders!(this.config.accountIndex);
    const orders = normalizeOrders(raw, this.config.markets);
    if (symbol) {
      const resolvedSymbol = this.marketMap.resolve(symbol).symbol;
      return orders.filter(o => o.symbol === resolvedSymbol);
    }
    return orders;
  }

  async getFinishedOrders(symbol: string, limit?: number): Promise<OrderResult[]> {
    const market = this.marketMap.resolve(symbol);
    const raw = await this.restClient.getAccountOrderHistory!(
      this.config.accountIndex,
      market.marketIndex,
      limit,
    );
    return normalizeOrders(raw, this.config.markets, symbol);
  }

  async getPriceOrders(symbol?: string): Promise<OrderResult[]> {
    const raw = await this.restClient.getAccountOrders!(this.config.accountIndex);
    const allOrders = normalizeOrders(raw, this.config.markets);

    const triggerTypes = new Set(['STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT']);

    const priceOrders = allOrders.filter((order, index) => {
      const rawRow = (raw as any).orders?.[index] ?? (Array.isArray(raw) ? (raw as any)[index] : undefined);
      const orderType = (order.type ?? '').toUpperCase();
      if (triggerTypes.has(orderType)) return true;
      if (rawRow && (rawRow.trigger_price !== undefined || rawRow.triggerPrice !== undefined)) return true;
      return false;
    });

    if (symbol) {
      const resolvedSymbol = this.marketMap.resolve(symbol).symbol;
      return priceOrders.filter(o => o.symbol === resolvedSymbol);
    }
    return priceOrders;
  }

  async waitForOrderFill(orderId: string, symbol: string, timeoutMs?: number): Promise<OrderResult> {
    this.marketMap.resolve(symbol);
    return this.reconciler.waitForFill(orderId, symbol, timeoutMs);
  }

  async getTradeHistory(symbol: string, limit?: number): Promise<Trade[]> {
    try {
      const market = this.marketMap.resolve(symbol);
      const raw = await this.restClient.getAccountTrades!(
        this.config.accountIndex,
        market.marketIndex,
        limit,
      );
      logger.debug(`[Lighter] getTradeHistory raw response: ${JSON.stringify(raw).substring(0, 500)}`);
      return normalizeLighterTrades(raw, symbol);
    } catch (err) {
      logger.warn(`[Lighter] getTradeHistory failed for ${symbol}`, formatError(err));
      return [];
    }
  }

  async getMarkets(): Promise<MarketInfo[]> {
    return this.marketMap.getMarkets();
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const market = this.marketMap.resolve(symbol);
    const raw = await this.restClient.getTicker!(market.marketIndex);
    return normalizeLighterTicker(raw, symbol);
  }

  private async calculateWorstAcceptablePrice(symbol: string, side: 'buy' | 'sell'): Promise<string> {
    const ticker = await this.getTicker(symbol);
    const lastPrice = parseFloat(ticker.lastPrice);
    if (!lastPrice || lastPrice <= 0) {
      throw new Error(`Unable to determine market price for ${symbol}`);
    }
    const slippage = this.config.marketOrderSlippage;
    const worstPrice = side === 'buy'
      ? lastPrice * (1 + slippage)
      : lastPrice * (1 - slippage);
    const decimals = this.marketMap.resolve(symbol).priceDecimals;
    return worstPrice.toFixed(decimals);
  }

  async getCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]> {
    const market = this.marketMap.resolve(symbol);
    const countBack = limit ?? 100;
    const endTimestamp = Date.now();
    const intervalMs = timeframeToMs(timeframe);
    const startTimestamp = endTimestamp - countBack * intervalMs;
    const raw = await this.restClient.getCandles!(
      market.marketIndex, timeframe, countBack, startTimestamp, endTimestamp,
    );
    return normalizeLighterCandles(raw);
  }

  async setLeverage(symbol: string, leverage: string): Promise<boolean> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(symbol);
    const initialMarginFraction = Math.round(10000 / Number(leverage));

    const intent = buildIntent('set_leverage', {
      symbol,
      marketIndex: market.marketIndex,
      payload: {
        market_index: market.marketIndex,
        initial_margin_fraction: initialMarginFraction,
      },
    });
    await this.nonceManager.submit(intent);
    return true;
  }

  async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', leverage?: string): Promise<boolean> {
    this.assertSafeToTrade();

    const market = this.marketMap.resolve(symbol);
    const leverageValue = leverage ?? '1';
    const initialMarginFraction = Math.round(10000 / Number(leverageValue));
    const marginModeInt = marginMode === 'isolated' ? 1 : 0;

    const intent = buildIntent('set_margin_mode', {
      symbol,
      marketIndex: market.marketIndex,
      payload: {
        market_index: market.marketIndex,
        initial_margin_fraction: initialMarginFraction,
        margin_mode: marginModeInt,
      },
    });
    await this.nonceManager.submit(intent);
    return true;
  }

  async getMarginMode(symbol: string): Promise<{ marginMode: 'cross' | 'isolated'; leverage: string }> {
    const position = await this.getPosition(symbol);
    return {
      marginMode: position?.marginType ?? 'cross',
      leverage: position?.leverage ?? '1',
    };
  }

  getWebSocketStats(): unknown {
    const stats = this.wsClient.getStats();
    if (stats && typeof stats === 'object') {
      return {
        ...stats,
        safeToTrade: this.safeToTrade,
        pausedReason: this.pausedReason,
      };
    }
    return {
      stats,
      safeToTrade: this.safeToTrade,
      pausedReason: this.pausedReason,
    };
  }

  private assertSafeToTrade(): void {
    if (!this.safeToTrade) {
      throw new Error(`Lighter exchange ${this.id} is not safe to trade`);
    }
  }

  private async getClosablePositionAmount(symbol: string): Promise<string> {
    const position = await this.getPosition(symbol);
    if (!position) {
      return '0';
    }
    return position.size.startsWith('-') ? position.size.slice(1) : position.size;
  }
}

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

function timeframeToMs(timeframe: string): number {
  return TIMEFRAME_MS[timeframe] ?? 3_600_000;
}

export default LighterExchange;
