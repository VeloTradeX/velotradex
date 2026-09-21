import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import auditService from '../../src/services/AuditService';
import { Order, SoftStopLoss } from '../../src/models';
import { extractTpStepFromRawMessage } from '../../src/services/OrderClassifier';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
  },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

jest.mock('../../src/models', () => ({
  Order: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  Strategy: {},
  StrategyPosition: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
  AuditLog: {},
  PendingProtection: {},
  SoftStopLoss: {
    create: jest.fn(),
  },
  sequelize: {},
}));

describe('TradeExecutor pre-open hard validation', () => {
  const mockExchange = {
    name: 'Mock Gate',
    getTicker: jest.fn(),
    getBalance: jest.fn(),
    getMarkets: jest.fn(),
    getPositions: jest.fn(),
    getOpenOrders: jest.fn(),
    getPriceOrders: jest.fn(),
    setMarginMode: jest.fn(),
    setLeverage: jest.fn(),
    placeOrder: jest.fn(),
    waitForOrderFill: jest.fn(),
    updateStopLoss: jest.fn(),
    closePosition: jest.fn(),
    getTradeHistory: jest.fn(),
    cancelOrder: jest.fn(),
    cancelPriceOrder: jest.fn(),
  };

  const baseRiskConfig = {
    riskMode: 'percentage' as const,
    riskValue: 1,
    defaultLeverage: '5',
    priceTolerance: 0.01,
    entryPaddingR: 0,
    tpPaddingR: 0,
    slPaddingR: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(mockExchange);
    mockExchange.getTicker.mockResolvedValue({ lastPrice: '100' });
    mockExchange.getBalance.mockResolvedValue({ total: '1000', available: '1000' });
    mockExchange.getMarkets.mockResolvedValue([
      {
        symbol: 'BTC_USDT',
        multiplier: '0.0001',
        leverageMax: '20',
        amountPrecision: 0,
        pricePrecision: 1,
      },
    ]);
    mockExchange.getPositions.mockResolvedValue([]);
    mockExchange.getOpenOrders.mockResolvedValue([]);
    mockExchange.getPriceOrders.mockResolvedValue([]);
    mockExchange.setMarginMode.mockResolvedValue(true);
    mockExchange.setLeverage.mockResolvedValue(true);
    mockExchange.placeOrder.mockResolvedValue({ id: 'entry-1', status: 'open', symbol: 'BTC_USDT', amount: '1', price: '101' });
    mockExchange.waitForOrderFill.mockReturnValue(new Promise(() => {}));
    mockExchange.updateStopLoss.mockResolvedValue('sl-1');
    mockExchange.closePosition.mockResolvedValue(true);
    mockExchange.getTradeHistory.mockResolvedValue([]);
    (Order.findOne as jest.Mock).mockResolvedValue(null);
    (Order.findAll as jest.Mock).mockResolvedValue([]);
    (Order.create as jest.Mock).mockResolvedValue({
      id: 1,
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '1',
      price: '101',
      lifecycleStatus: 'INIT',
      save: jest.fn(),
    });
    (auditService.log as jest.Mock).mockResolvedValue(undefined);
  });

  async function expectRejected(
    parsedPatch: Record<string, unknown>,
    expectedReason: string,
    expectedField: string,
    expectedCurrentPrice: unknown = 100,
    expectExchangeReads: boolean = true,
  ) {
    const parsed = {
      action: 'open' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      entryPrice: '101',
      stopLoss: '95',
      targets: ['110'],
      raw: {},
      ...parsedPatch,
    };

    const execution = (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    await expect(execution).rejects.toThrow(expectedReason);

    expect(Order.create).not.toHaveBeenCalled();
    expect(mockExchange.placeOrder).not.toHaveBeenCalled();
    expect(mockExchange.setLeverage).not.toHaveBeenCalled();
    expect(mockExchange.waitForOrderFill).not.toHaveBeenCalled();
    expect(mockExchange.getOpenOrders).not.toHaveBeenCalled();
    expect(Order.findAll).not.toHaveBeenCalled();

    const expectedAuditEntryPrice = expectExchangeReads ? Number(parsed.entryPrice) : parsed.entryPrice;
    const expectedAuditStopLoss = expectExchangeReads ? Number(parsed.stopLoss) : parsed.stopLoss;

    if (expectExchangeReads) {
      expect(mockExchange.getTicker).toHaveBeenCalled();
      expect(mockExchange.getMarkets).toHaveBeenCalled();
      expect(mockExchange.getBalance).not.toHaveBeenCalled();
      expect(mockExchange.getPositions).not.toHaveBeenCalled();
    } else {
      expect(mockExchange.getTicker).not.toHaveBeenCalled();
      expect(mockExchange.getBalance).not.toHaveBeenCalled();
      expect(mockExchange.getMarkets).not.toHaveBeenCalled();
      expect(mockExchange.getPositions).not.toHaveBeenCalled();
    }

    const rejectionAudits = (auditService.log as jest.Mock).mock.calls.filter(
      ([strategyId, action]) => strategyId === 123 && action === 'STRATEGY_REJECTED',
    );
    expect(rejectionAudits).toHaveLength(1);
    const rejectionAudit = rejectionAudits[0];
    expect(rejectionAudit).toBeDefined();
    expect(rejectionAudit[2]).toEqual(expect.objectContaining({
      symbol: parsed.symbol,
      side: parsed.side,
      entryPrice: expectedAuditEntryPrice,
      stopLoss: expectedAuditStopLoss,
      currentPrice: expectedCurrentPrice,
      field: expectedField,
      reason: expect.stringContaining(expectedReason),
    }));
    expect(rejectionAudit[5]).toBe('mock-exchange');
  }

  it('rejects missing symbol before order creation', async () => {
    await expectRejected({ symbol: '' }, 'Invalid open strategy symbol', 'symbol', null, false);
  });

  it('rejects unsupported symbol before order creation', async () => {
    await expectRejected({ symbol: 'ETH_USDT' }, 'Unsupported open strategy symbol: ETH_USDT', 'symbol', 100, true);
  });

  it('rejects invalid side before order creation', async () => {
    await expectRejected({ side: 'hold' }, 'Invalid open strategy side', 'side', null, false);
  });

  it('rejects non-positive entry price before order creation', async () => {
    await expectRejected({ entryPrice: '0' }, 'Invalid open strategy entryPrice', 'entryPrice', null, false);
  });

  it('rejects non-positive stop loss before order creation', async () => {
    await expectRejected({ stopLoss: '-1' }, 'Invalid open strategy stopLoss', 'stopLoss', null, false);
  });

  it('rejects zero R before order creation', async () => {
    await expectRejected({ entryPrice: '100', stopLoss: '100' }, 'Invalid open strategy R', 'R', null, false);
  });

  it('rejects long stop loss at or above current price before order creation', async () => {
    await expectRejected({ stopLoss: '100' }, 'Invalid Long Strategy', 'stopLoss');
  });

  it('rejects short stop loss at or below current price before order creation', async () => {
    await expectRejected({ side: 'sell', entryPrice: '99', stopLoss: '100' }, 'Invalid Short Strategy', 'stopLoss');
  });

  it('rejects invalid current price before order creation', async () => {
    mockExchange.getTicker.mockResolvedValue({ lastPrice: 'NaN' });
    await expectRejected({}, 'Invalid open strategy currentPrice', 'currentPrice', null, true);
  });

  it('trims whitespace-padded symbol without mutating input', async () => {
    const parsed = {
      action: 'open' as const,
      symbol: ' BTC_USDT ',
      side: 'buy' as const,
      entryPrice: '0',
      stopLoss: '95',
      targets: ['110'],
      raw: {},
    };

    const execution = (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    await expect(execution).rejects.toThrow('Invalid open strategy entryPrice');
    expect(parsed.symbol).toBe(' BTC_USDT ');
    expect(mockExchange.getTicker).not.toHaveBeenCalled();
    const rejectionAudits = (auditService.log as jest.Mock).mock.calls.filter(
      ([strategyId, action]) => strategyId === 123 && action === 'STRATEGY_REJECTED',
    );
    expect(rejectionAudits[0][2]).toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
    }));
  });

  it('uses normalized symbol through the successful open path without mutating input', async () => {
    const parsed = {
      action: 'open' as const,
      symbol: ' BTC_USDT ',
      side: 'buy' as const,
      entryPrice: '101',
      stopLoss: '95',
      targets: ['110'],
      raw: {},
    };

    const result = await (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(result).toEqual(expect.objectContaining({ id: 'entry-1' }));
    expect(parsed.symbol).toBe(' BTC_USDT ');
    expect(mockExchange.getTicker).toHaveBeenCalledWith('BTC_USDT');
    expect(mockExchange.getMarkets).toHaveBeenCalled();
    expect(mockExchange.getBalance).toHaveBeenCalled();
    expect(mockExchange.getPositions).toHaveBeenCalled();
    expect(mockExchange.getOpenOrders).toHaveBeenCalledWith('BTC_USDT');
    expect(Order.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ symbol: 'BTC_USDT' }),
    }));
    expect(mockExchange.setLeverage).toHaveBeenCalledWith('BTC_USDT', '0');
    expect(mockExchange.setMarginMode).not.toHaveBeenCalled();
    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      side: 'buy',
    }));
    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      side: 'buy',
    }));
    expect(mockExchange.waitForOrderFill).toHaveBeenCalledWith('entry-1', 'BTC_USDT', undefined);
  });

  it('keeps Gate opening orders in cross margin without issuing a separate max leverage update', async () => {
    Object.defineProperty(mockExchange, 'constructor', {
      value: { name: 'GateIOExchange' },
      configurable: true,
    });
    mockExchange.getPositions.mockResolvedValue([
      {
        symbol: 'BTC_USDT',
        size: '0',
        entryPrice: '0',
        markPrice: '0',
        unrealizedPnl: '0',
        leverage: '20',
        marginType: 'isolated',
      },
    ]);

    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '101',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(mockExchange.setLeverage).toHaveBeenCalledWith('BTC_USDT', '0');
    expect(mockExchange.setMarginMode).not.toHaveBeenCalled();
    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      leverage: '20',
    }));
  });

  it('passes the first calculated take profit to the entry order for pending protection', async () => {
    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '101',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      stopLoss: '95.0',
      takeProfit: '110',
    }));
  });

  it('keeps taker limit entries as resting limit orders without forcing IOC', async () => {
    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '99',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      { ...baseRiskConfig, entryOrderMode: 'taker' },
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    const placedOrder = mockExchange.placeOrder.mock.calls[0][0];
    expect(placedOrder).toEqual(expect.objectContaining({
      type: 'limit',
      postOnly: undefined,
    }));
    expect(placedOrder).not.toHaveProperty('timeInForce', 'IOC');
  });

  it('uses the local order id in the entry order text so Lighter client indexes are not reused per source', async () => {
    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '101',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      text: 't-entry-1',
    }));
  });

  it('does not start the fill monitor with a zero millisecond timeout', async () => {
    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '101',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(mockExchange.waitForOrderFill).toHaveBeenCalledWith('entry-1', 'BTC_USDT', undefined);
  });

  it('uses a finite fill timeout for Lighter so REST fallback can place protections', async () => {
    Object.defineProperty(mockExchange, 'constructor', {
      value: { name: 'LighterExchange' },
      configurable: true,
    });

    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'BTC_USDT',
        side: 'buy' as const,
        entryPrice: '101',
        stopLoss: '95',
        targets: ['110'],
        raw: {},
      },
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(mockExchange.waitForOrderFill).toHaveBeenCalledWith('entry-1', 'BTC_USDT', 15000);
  });

  it('normalizes 1000x display-unit strategy prices against Gate market price before validation and execution', async () => {
    mockExchange.getTicker.mockResolvedValue({ lastPrice: '0.000004132' });
    mockExchange.getMarkets.mockResolvedValue([
      {
        symbol: 'PEPE_USDT',
        multiplier: '1',
        leverageMax: '20',
        amountPrecision: 0,
        pricePrecision: 12,
      },
    ]);
    (Order.create as jest.Mock).mockResolvedValue({
      id: 1,
      symbol: 'PEPE_USDT',
      side: 'buy',
      amount: '1',
      price: '0.000004132',
      lifecycleStatus: 'INIT',
      save: jest.fn(),
    });

    const parsed = {
      action: 'open' as const,
      symbol: 'PEPE_USDT',
      side: 'buy' as const,
      entryPrice: '0.004132',
      stopLoss: '0.004071',
      targets: ['0.0043'],
      raw: {},
    };

    const result = await (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(result).toEqual(expect.objectContaining({ id: 'entry-1' }));
    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'PEPE_USDT',
      price: '0.000004132',
      initialSl: '0.000004071000',
      initialTp: '0.0000043',
    }));
    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'PEPE_USDT',
      type: 'market',
      price: undefined,
      stopLoss: '0.000004071000',
    }));
    expect(auditService.log).toHaveBeenCalledWith(
      123,
      'STRATEGY_PRICE_SCALE_NORMALIZED',
      expect.objectContaining({
        symbol: 'PEPE_USDT',
        scaleFactor: 1000,
        originalEntryPrice: 0.004132,
        normalizedEntryPrice: 0.000004132,
        originalStopLoss: 0.004071,
        normalizedStopLoss: 0.000004071,
      }),
      undefined,
      undefined,
      'mock-exchange',
    );
  });

  it('resolves Neil CMP entries to current price, computes hard stop, and places a market order', async () => {
    const parsed = {
      action: 'open' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      entryPrice: 'CMP',
      stopLoss: '95',
      targets: ['110'],
      orderType: 'market' as const,
      raw: {
        neil: {
          parserName: 'NeilParser',
          softStop: {
            price: 95,
            timeframe: '4h',
            direction: 'close_under',
            sourceText: '4H close under 95 for stops',
            status: 'active',
          },
          hardStopRMultiplier: 2,
          hardStopLoss: null,
        },
      },
    };

    const result = await (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(result).toEqual(expect.objectContaining({ id: 'entry-1' }));
    expect(mockExchange.getTicker).toHaveBeenCalledWith('BTC_USDT');
    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      price: '100.0',
      type: 'market',
      initialSl: '90.0',
    }));
    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      type: 'market',
      price: undefined,
      stopLoss: '90.0',
    }));
    expect(SoftStopLoss.create).toHaveBeenCalledWith(expect.objectContaining({
      raw: expect.stringContaining('"hardStopLoss":90'),
    }));
  });

  it('resolves Neil CMP fallback full TP at 1.1R after current entry is known', async () => {
    const parsed = {
      action: 'open' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      entryPrice: 'CMP',
      stopLoss: '95',
      targets: [],
      orderType: 'market' as const,
      raw: {
        neil: {
          parserName: 'NeilParser',
          softStop: {
            price: 95,
            timeframe: '4h',
            direction: 'close_under',
            sourceText: '4H close under 95 for stops',
            status: 'active',
          },
          hardStopRMultiplier: 2,
          hardStopLoss: null,
          fallbackFullTp: {
            enabled: true,
            rMultiple: 1.1,
            deferUntilEntryResolved: true,
          },
        },
      },
    };

    await (tradeExecutor as any).handleOpen(
      parsed,
      baseRiskConfig,
      'unit-test-source',
      123,
      'mock-exchange',
      77,
    );

    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      initialSl: '90.0',
      initialTp: '111',
    }));
  });

  it('updates a position-level stop loss when no local order is found for an active exchange position', async () => {
    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'ETH_USDT', size: '0.25', entryPrice: '3500' },
    ]);

    const result = await (tradeExecutor as any).handleUpdate(
      { action: 'update', symbol: 'ETH_USDT', stopLoss: '3450', raw: {} },
      397,
      'mock-exchange',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'ETH_USDT' }));
    expect(mockExchange.updateStopLoss).toHaveBeenCalledWith(
      'ETH_USDT',
      'buy',
      '3450',
      't-sl-pos-ETH_USDT-sell', // close-side convention (long position → closeSide=sell)
      '0.25',
    );
  });

  it('moves stop loss to breakeven from exchange position entry when no local order is found', async () => {
    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'ETH_USDT', size: '0.25', entryPrice: '3500' },
    ]);

    const result = await (tradeExecutor as any).handleUpdate(
      {
        action: 'update',
        symbol: 'ETH_USDT',
        side: 'buy',
        closePercentage: null,
        closePrice: null,
        entryPrice: null,
        stopLoss: 'breakeven',
        targets: [],
        orderType: null,
        riskMultiplier: null,
        confidence: 0.95,
        raw: {},
      },
      397,
      'mock-exchange',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'ETH_USDT' }));
    expect(mockExchange.updateStopLoss).toHaveBeenCalledWith(
      'ETH_USDT',
      'buy',
      '3500',
      't-sl-pos-ETH_USDT-sell', // close-side convention (long position → closeSide=sell)
      '0.25',
    );
  });

  it('updates SL and syncs DB activeStopLossId when target order is recently CLOSED (WSEventRouter premature closure)', async () => {
    // Simulate: WSEventRouter marked order as CLOSED, but SL update still arrives.
    // First call: OPEN/PROTECTED lookup returns null.
    // Second call: recently CLOSED order found.
    const closedOrder = {
      id: 696,
      strategyId: 700,
      symbol: 'BTC_USDT',
      side: 'sell',
      lifecycleStatus: 'CLOSED',
      filledPrice: '60511.4',
      price: '60520',
      exchangeOrderId: '82472172175073235',
      activeStopLossId: '2070950297169035264',
      currentSl: '60823',
      amount: 327,
      closedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      save: jest.fn().mockResolvedValue(true),
    };

    (Order.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // OPEN/PROTECTED lookup fails
      .mockResolvedValueOnce(closedOrder); // recently CLOSED lookup succeeds

    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '-164', entryPrice: '60511.4' },
    ]);
    mockExchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', multiplier: '0.0001', leverageMax: '20', amountPrecision: 0, pricePrecision: 1 },
    ]);
    mockExchange.updateStopLoss.mockResolvedValue('2070950585967837184');

    const result = await (tradeExecutor as any).handleUpdate(
      {
        action: 'update',
        symbol: 'BTC_USDT',
        side: 'sell',
        stopLoss: '60200',
        raw: {},
      },
      700,
      'mock-exchange',
    );

    // SL was updated on the exchange
    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'BTC_USDT' }));

    // Used exchange.updateStopLoss (position-level) since the order is CLOSED
    // side='sell' = position direction (short position), NOT close direction
    // SL text uses close-side convention: closeSide = 'buy' for short positions
    expect(mockExchange.updateStopLoss).toHaveBeenCalledWith(
      'BTC_USDT',
      'sell', // short position → side is position direction
      '60200',
      't-sl-pos-BTC_USDT-buy', // close-side convention (short position → closeSide=buy)
      '327', // uses order tracked amount (327) since targetOrder exists
    );

    // DB was synced: activeStopLossId and currentSl updated on the CLOSED order
    expect(closedOrder.activeStopLossId).toBe('2070950585967837184');
    expect(closedOrder.currentSl).toBe('60200');
    expect(closedOrder.save).toHaveBeenCalled();
  });

  it('returns null when no local scoped order exists but exchange position is present (manual intervention)', async () => {
    mockExchange.getMarkets.mockResolvedValue([
      {
        symbol: 'BTC_USDT',
        multiplier: '0.0001',
        leverageMax: '20',
        amountPrecision: 4,
        pricePrecision: 1,
      },
    ]);
    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '-0.5', entryPrice: '100000' },
    ]);
    (Order.findAll as jest.Mock).mockResolvedValue([]);

    const result = await tradeExecutor.execute(
      {
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'sell',
        closePercentage: 70,
        raw: {},
      },
      baseRiskConfig,
      'opxbt',
      397,
      'lighter-main',
      77,
    );

    expect(result).toBeNull();
    expect(mockExchange.closePosition).not.toHaveBeenCalled();
  });

  it('maps first TP wording to TP1 distribution when closePercentage is omitted', () => {
    const step = extractTpStepFromRawMessage({
      content: 'Taking first TP here and moving stops BE',
    });

    expect(step).toBe(1);
  });

  it('finds target order by routeId widening when strategyId does not match', async () => {
    // Simulate: open signal (strategyId=100) creates order with routeId=16
    // update signal (strategyId=200) has different strategyId but same routeId
    const targetOrder = {
      id: 500,
      strategyId: 100,
      symbol: 'BTC_USDT',
      side: 'sell',
      lifecycleStatus: 'PROTECTED',
      exchangeOrderId: 'exch-500',
      filledPrice: '60000',
      currentSl: '60500',
      activeStopLossId: 'sl-500',
      save: jest.fn().mockResolvedValue(undefined),
    };

    // strategyId=200 doesn't match order's strategyId=100, so first lookup fails
    (Order.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // strategyId lookup fails
      .mockResolvedValueOnce(null) // recently CLOSED by strategyId fails
      .mockResolvedValueOnce(targetOrder); // routeId widening succeeds

    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '-1', entryPrice: '60000' },
    ]);
    mockExchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', pricePrecision: 1 },
    ]);
    (mockExchange.updateStopLoss as jest.Mock).mockResolvedValue('sl-new');

    const result = await (tradeExecutor as any).handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'sell', stopLoss: '59000', raw: { routeId: 16 } },
      200, // different strategyId from the order
      'mock-exchange',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'BTC_USDT' }));
    expect(targetOrder.currentSl).toBe('59000');
    expect(targetOrder.activeStopLossId).toBe('sl-new');
    expect(targetOrder.save).toHaveBeenCalled();
  });

  it('finds target order by source widening when strategyId and routeId do not match', async () => {
    const targetOrder = {
      id: 501,
      strategyId: 100,
      symbol: 'BTC_USDT',
      side: 'sell',
      lifecycleStatus: 'PROTECTED',
      exchangeOrderId: 'exch-501',
      filledPrice: '60000',
      currentSl: '60500',
      activeStopLossId: 'sl-501',
      save: jest.fn().mockResolvedValue(undefined),
    };

    (Order.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // strategyId lookup fails
      .mockResolvedValueOnce(null) // recently CLOSED by strategyId fails
      .mockResolvedValueOnce(targetOrder); // source widening succeeds

    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '-1', entryPrice: '60000' },
    ]);
    mockExchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', pricePrecision: 1 },
    ]);
    (mockExchange.updateStopLoss as jest.Mock).mockResolvedValue('sl-new');

    const result = await (tradeExecutor as any).handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'sell', stopLoss: '59000', raw: { source: '100000000000000001' } },
      200, // different strategyId
      'mock-exchange',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'BTC_USDT' }));
    expect(targetOrder.currentSl).toBe('59000');
    expect(targetOrder.activeStopLossId).toBe('sl-new');
    expect(targetOrder.save).toHaveBeenCalled();
  });

  it('skips widening when parsed.raw has no routeId or source', async () => {
    // When raw has no routeId/source, widening should not happen
    // and handleUpdate falls through to position-level SL update (no DB sync)
    (Order.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // strategyId lookup fails
      .mockResolvedValueOnce(null); // recently CLOSED by strategyId fails

    mockExchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '-1', entryPrice: '60000' },
    ]);
    mockExchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', pricePrecision: 1 },
    ]);
    (mockExchange.updateStopLoss as jest.Mock).mockResolvedValue('sl-new');

    const result = await (tradeExecutor as any).handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'sell', stopLoss: '59000', raw: {} },
      200, // different strategyId
      'mock-exchange',
    );

    // Should still work (position-level SL), just no DB sync
    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'BTC_USDT' }));
    // Only 2 findOne calls (strategyId + recently CLOSED), no widening call
    expect(Order.findOne).toHaveBeenCalledTimes(2);
  });
});
