import { NoStopLossMonitor } from '../../src/services/NoStopLossMonitor';
import { Order, PendingProtection, VirtualTrade } from '../../src/models';
import exchangeRegistry from '../../src/services/exchanges';

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

describe('NoStopLossMonitor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hasStopLoss matches by id and legacy text', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const order = {
      id: 1,
      symbol: 'BTC_USDT',
      exchangeOrderId: '82472171406123676',
      activeStopLossId: 't-sl-ord-82472171406123676',
    };
    const exchange = {
      getPriceOrders: jest.fn().mockResolvedValue([
        { id: '82472171406124380', text: 't-sl-ord-82472171406123676', initial: { text: 't-sl-ord-82472171406123676', contract: 'BTC_USDT', reduce_only: true }, trigger: { rule: 2 } },
      ]),
    };

    const exists = await monitor.hasStopLoss(order, 'buy', exchange);
    expect(exists).toBe(true);
  });

  it('hasStopLoss recognizes Lighter normalized stop-loss orders', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const order = {
      id: 11,
      symbol: 'XAU_USDT',
      exchangeOrderId: '38525356840653',
      activeStopLossId: null,
    };
    const exchange = {
      getPriceOrders: jest.fn().mockResolvedValue([
        {
          id: 'sl-11',
          symbol: 'XAU_USDT',
          side: 'sell',
          type: 'STOP_LOSS',
          raw: {
            reduce_only: true,
            trigger_price: '4679.76',
          },
        },
      ]),
    };

    const exists = await monitor.hasStopLoss(order, 'buy', exchange);
    expect(exists).toBe(true);
  });

  it('hasStopLoss recognizes order-attached SL (close-long-order / tpsl_sl_trigger_price)', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const order = {
      id: 12,
      symbol: 'BTC_USDT',
      exchangeOrderId: '82472171409999999',
      activeStopLossId: null,
    };
    // Gate 订单自带 SL 在 price_orders 中表现为 order_type=close-long-order 的
    // reduce-only 触发单（rule=2 对应多头 SL）。SDK 反序列化为 camelCase orderType。
    const exchange = {
      getPriceOrders: jest.fn().mockResolvedValue([
        {
          id: 'attached-sl-1',
          orderType: 'close-long-order',
          initial: { contract: 'BTC_USDT', reduce_only: true },
          trigger: { rule: 2, price: '74000' },
        },
      ]),
    };

    const exists = await monitor.hasStopLoss(order, 'buy', exchange);
    expect(exists).toBe(true);
  });

  it('hasStopLoss does NOT treat close-long-order TP leg as SL', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const order = {
      id: 13,
      symbol: 'BTC_USDT',
      exchangeOrderId: '82472171408888888',
      activeStopLossId: null,
    };
    // 同类型的 close-long-order 但 rule=1 是 TP 腿（多头 TP），不能冒充 SL
    const exchange = {
      getPriceOrders: jest.fn().mockResolvedValue([
        {
          id: 'attached-tp-1',
          orderType: 'close-long-order',
          initial: { contract: 'BTC_USDT', reduce_only: true },
          trigger: { rule: 1, price: '76000' },
        },
      ]),
    };

    const exists = await monitor.hasStopLoss(order, 'buy', exchange);
    expect(exists).toBe(false);
  });

  it('returns unknown and records degraded state when getPriceOrders repeatedly fails', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    (monitor as any).FETCH_RETRY = 0;
    (monitor as any).FETCH_RETRY_DELAY_MS = 0;
    const order = {
      id: 2,
      symbol: 'BTC_USDT',
      side: 'buy',
      exchangeInstanceId: 'mock-ex',
      strategyId: 22,
      exchangeOrderId: '82472171406123676',
      activeStopLossId: '82472171406124380',
    };
    const exchange = {
      getPriceOrders: jest.fn().mockRejectedValue(new Error('timeout')),
    };

    const state = await monitor.getStopLossState(order, 'buy', exchange);
    expect(state).toBe('unknown');
    expect((monitor as any).queryFailureState.get('mock-ex:BTC_USDT:buy')).toEqual(
      expect.objectContaining({
        failureCount: 1,
        lastError: 'timeout',
      }),
    );

    const exists = await monitor.hasStopLoss(order, 'buy', exchange);
    expect(exists).toBe(true);
  });

  it('does not close order on first absent-position precheck', async () => {
    const cancelProtections = jest.fn();
    const monitor = new (NoStopLossMonitor as any)({
      getProtectionPipeline: jest.fn().mockReturnValue({ cancelProtections }),
    });
    const dbOrder = {
      id: 3,
      symbol: 'BTC_USDT',
      side: 'buy',
      status: 'filled',
      lifecycleStatus: 'OPEN',
      exchangeInstanceId: 'mock-ex',
      exchangeOrderId: '82472171406202682',
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);
    jest.spyOn(Order, 'findAll').mockResolvedValue([]);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue(null),
      getPriceOrders: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    (monitor as any).state.set('3', {
      orderId: '3',
      symbol: 'BTC_USDT',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      positionAbsentSince: undefined,
    });

    const now = Date.now();
    await monitor.checkOrder('3', now);
    expect(dbOrder.save).not.toHaveBeenCalled();
    expect(cancelProtections).not.toHaveBeenCalled();

    await monitor.checkOrder('3', now + 1000);
    expect(dbOrder.save).not.toHaveBeenCalled();
    expect(cancelProtections).not.toHaveBeenCalled();

    await monitor.checkOrder('3', now + 13000);
    expect(dbOrder.save).toHaveBeenCalledTimes(1);
    expect(cancelProtections).toHaveBeenCalledWith('BTC_USDT', 'buy', '82472171406202682');
  });

  it('backfills virtual close price and pnl when marking absent-position order closed', async () => {
    const cancelProtections = jest.fn();
    const monitor = new (NoStopLossMonitor as any)({
      getProtectionPipeline: jest.fn().mockReturnValue({ cancelProtections }),
    });
    const dbOrder: any = {
      id: 599,
      symbol: 'ETH_USDT',
      side: 'buy',
      status: 'filled',
      lifecycleStatus: 'OPEN',
      exchangeInstanceId: 'v-always-win',
      exchangeOrderId: 'vo-entry-599',
      activeStopLossId: 'vo-sl-599',
      createdAt: new Date(Date.now() - 120_000),
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);
    jest.spyOn(Order, 'findAll').mockResolvedValue([]);
    jest.spyOn(VirtualTrade, 'findAll').mockResolvedValue([
      { virtualOrderId: 'vo-entry-599', price: '1976.04', realizedPnl: '0', text: 't-entry-599', executedAt: new Date('2026-06-01T15:37:51.944Z') },
      { virtualOrderId: 'vo-sl-599', price: '1971.96', realizedPnl: '-49.98', text: 't-sl-pos-ETH_USDT-buy', executedAt: new Date('2026-06-01T15:46:50.914Z') },
    ] as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue(null),
      getPriceOrders: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    (monitor as any).state.set('599', {
      orderId: '599',
      symbol: 'ETH_USDT',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      positionAbsentSince: Date.now() - 60_000,
      missingConfirmations: 0,
    });

    await monitor.checkOrder('599', Date.now());

    expect(dbOrder.save).toHaveBeenCalled();
    expect(dbOrder.status).toBe('closed');
    expect(dbOrder.lifecycleStatus).toBe('CLOSED');
    expect(dbOrder.exitPrice).toBe('1971.96');
    expect(dbOrder.closePrice).toBe('1971.96');
    expect(dbOrder.lastPrice).toBe('1971.96');
    expect(dbOrder.realizedPnl).toBe('-49.9800');
  });

  it('does not auto-close when stop-loss state is unknown', async () => {
    const handleClose = jest.fn();
    const monitor = new (NoStopLossMonitor as any)({ handleClose });
    (monitor as any).FETCH_RETRY = 0;
    (monitor as any).FETCH_RETRY_DELAY_MS = 0;
    const dbOrder = {
      id: 4,
      symbol: 'BTC_USDT',
      side: 'buy',
      status: 'filled',
      lifecycleStatus: 'OPEN',
      exchangeInstanceId: 'mock-ex',
      strategyId: 44,
      exchangeOrderId: 'entry-4',
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', size: '1' }),
      getPriceOrders: jest.fn().mockRejectedValue(new Error('timeout')),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    (monitor as any).state.set('4', {
      orderId: '4',
      symbol: 'BTC_USDT',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      positionAbsentSince: undefined,
      missingConfirmations: 0,
      firstMissingAt: undefined,
      lastMissingAt: undefined,
    });

    await monitor.checkOrder('4', Date.now() + 60000);

    expect(handleClose).not.toHaveBeenCalled();
    expect((monitor as any).queryFailureState.get('mock-ex:BTC_USDT:buy')).toEqual(
      expect.objectContaining({
        failureCount: 1,
        lastError: 'timeout',
      }),
    );
  });

  it('auto-closes after confirmed missing stop loss reaches threshold', async () => {
    const handleClose = jest.fn().mockResolvedValue({ status: 'filled' });
    const monitor = new (NoStopLossMonitor as any)({ handleClose });
    const dbOrder = {
      id: 5,
      symbol: 'BTC_USDT',
      side: 'buy',
      status: 'filled',
      lifecycleStatus: 'OPEN',
      exchangeInstanceId: 'mock-ex',
      strategyId: 55,
      exchangeOrderId: 'entry-5',
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', size: '1' }),
      getPriceOrders: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    const now = Date.now();
    (monitor as any).state.set('5', {
      orderId: '5',
      symbol: 'BTC_USDT',
      checkedAt: now - 60000,
      graceEndsAt: now - 1,
      confirmed: false,
      positionAbsentSince: undefined,
      missingConfirmations: 0,
      firstMissingAt: undefined,
      lastMissingAt: undefined,
    });

    await monitor.checkOrder('5', now);
    expect(handleClose).not.toHaveBeenCalled();

    await monitor.checkOrder('5', now + 5000);
    expect(handleClose).not.toHaveBeenCalled();

    await monitor.checkOrder('5', now + 10000);
    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        symbol: 'BTC_USDT',
        closePercentage: 100,
      }),
      'system',
      undefined,
      55,
      'buy',
      'mock-ex',
    );
  });

  it('auto-closes a pending order when the exchange already has a matching live position without stop loss', async () => {
    const handleClose = jest.fn().mockResolvedValue({ status: 'filled' });
    const monitor = new (NoStopLossMonitor as any)({ handleClose });
    (monitor as any).GRACE_MS = 0;
    (monitor as any).MISSING_SL_CONFIRMATIONS = 1;

    const dbOrder = {
      id: 9,
      symbol: 'BTC_USDT',
      side: 'sell',
      status: 'accepted',
      lifecycleStatus: 'PENDING',
      exchangeInstanceId: 'r-lighter',
      strategyId: 99,
      exchangeOrderId: '78448872608597',
      isSimulated: false,
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findAll').mockImplementation(async (query: any) => {
      const statuses = query?.where?.lifecycleStatus || [];
      return statuses.includes('PENDING') ? [dbOrder] as any : [] as any;
    });
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', size: '-0.01138' }),
      getPriceOrders: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    await monitor.checkAll();

    expect(handleClose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        symbol: 'BTC_USDT',
        closePercentage: 100,
      }),
      'system',
      undefined,
      99,
      'sell',
      'r-lighter',
    );
  });

  it('does not close a pending order that has no live position yet', async () => {
    const handleClose = jest.fn();
    const monitor = new (NoStopLossMonitor as any)({ handleClose });
    (monitor as any).CONFIRM_MS = 0;

    const dbOrder = {
      id: 10,
      symbol: 'BTC_USDT',
      side: 'sell',
      status: 'accepted',
      lifecycleStatus: 'PENDING',
      exchangeInstanceId: 'r-lighter',
      strategyId: 100,
      exchangeOrderId: '78448872608598',
      isSimulated: false,
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue(null),
      getPriceOrders: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    (monitor as any).state.set('10', {
      orderId: '10',
      symbol: 'BTC_USDT',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      positionAbsentSince: Date.now() - 60_000,
      missingConfirmations: 0,
    });

    await monitor.checkOrder('10', Date.now());

    expect(handleClose).not.toHaveBeenCalled();
    expect(dbOrder.save).not.toHaveBeenCalled();
  });

  it('resets missing counters when stop loss becomes present', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const dbOrder = {
      id: 6,
      symbol: 'BTC_USDT',
      side: 'buy',
      status: 'filled',
      lifecycleStatus: 'OPEN',
      exchangeInstanceId: 'mock-ex',
      strategyId: 66,
      exchangeOrderId: 'entry-6',
      save: jest.fn(),
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    const exchange = {
      getPosition: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', size: '1' }),
      getPriceOrders: jest.fn().mockResolvedValue([
        {
          id: 'sl-6',
          trigger: { rule: 2 },
          initial: { reduce_only: true, contract: 'BTC_USDT' },
        },
      ]),
    };
    jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(exchange as any);

    (monitor as any).state.set('6', {
      orderId: '6',
      symbol: 'BTC_USDT',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: true,
      positionAbsentSince: undefined,
      missingConfirmations: 2,
      firstMissingAt: Date.now() - 10000,
      lastMissingAt: Date.now() - 5000,
    });
    (monitor as any).queryFailureState.set('mock-ex:BTC_USDT:buy', {
      failureCount: 2,
      firstFailureAt: Date.now() - 10000,
      lastFailureAt: Date.now() - 5000,
      lastError: 'timeout',
      alerted: false,
    });

    await monitor.checkOrder('6', Date.now());

    const state = (monitor as any).state.get('6');
    expect(state.missingConfirmations).toBe(0);
    expect(state.firstMissingAt).toBeUndefined();
    expect(state.lastMissingAt).toBeUndefined();
    expect((monitor as any).queryFailureState.has('mock-ex:BTC_USDT:buy')).toBe(false);
  });

  it('clears stale query failure state when an order leaves monitoring', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    jest.spyOn(Order, 'findAll').mockResolvedValue([] as any);

    (monitor as any).state.set('7', {
      orderId: '7',
      symbol: 'BTC_USDT',
      side: 'buy',
      exchangeInstanceId: 'mock-ex',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      missingConfirmations: 0,
      firstMissingAt: undefined,
      lastMissingAt: undefined,
    });
    (monitor as any).queryFailureState.set('mock-ex:BTC_USDT:buy', {
      failureCount: 2,
      firstFailureAt: Date.now() - 10000,
      lastFailureAt: Date.now() - 5000,
      lastError: 'timeout',
      alerted: false,
    });

    await monitor.checkAll();

    expect((monitor as any).state.has('7')).toBe(false);
    expect((monitor as any).queryFailureState.has('mock-ex:BTC_USDT:buy')).toBe(false);
  });

  it('clears query failure state when monitor stops', () => {
    const monitor = new (NoStopLossMonitor as any)({});
    (monitor as any).queryFailureState.set('mock-ex:BTC_USDT:buy', {
      failureCount: 2,
      firstFailureAt: Date.now() - 10000,
      lastFailureAt: Date.now() - 5000,
      lastError: 'timeout',
      alerted: false,
    });

    monitor.stop();

    expect((monitor as any).queryFailureState.size).toBe(0);
  });

  it('clears query failure state when a watched order is already closed', async () => {
    const monitor = new (NoStopLossMonitor as any)({});
    const dbOrder = {
      id: 8,
      symbol: 'BTC_USDT',
      side: 'buy',
      lifecycleStatus: 'CLOSED',
      exchangeInstanceId: 'mock-ex',
    };
    jest.spyOn(Order, 'findOne').mockResolvedValue(dbOrder as any);

    (monitor as any).state.set('8', {
      orderId: '8',
      symbol: 'BTC_USDT',
      side: 'buy',
      exchangeInstanceId: 'mock-ex',
      checkedAt: 0,
      graceEndsAt: 0,
      confirmed: false,
      missingConfirmations: 0,
      firstMissingAt: undefined,
      lastMissingAt: undefined,
    });
    (monitor as any).queryFailureState.set('mock-ex:BTC_USDT:buy', {
      failureCount: 2,
      firstFailureAt: Date.now() - 10000,
      lastFailureAt: Date.now() - 5000,
      lastError: 'timeout',
      alerted: false,
    });

    await monitor.checkOrder('8', Date.now());

    expect((monitor as any).state.has('8')).toBe(false);
    expect((monitor as any).queryFailureState.has('mock-ex:BTC_USDT:buy')).toBe(false);
  });

  describe('SL re-placement before auto-close', () => {
    it('attempts to re-place SL via ProtectionPipeline before auto-close', async () => {
      const mockPlaceProtections = jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true });
      const mockPipeline = { placeProtections: mockPlaceProtections };
      const mockGetProtectionPipeline = jest.fn().mockReturnValue(mockPipeline);
      const mockHandleClose = jest.fn();

      const monitor = new NoStopLossMonitor({
        getProtectionPipeline: mockGetProtectionPipeline,
        handleClose: mockHandleClose,
      } as any);
      // Short-circuit timing
      (monitor as any).GRACE_MS = 0;
      (monitor as any).CONFIRM_MS = 0;
      (monitor as any).MISSING_SL_CONFIRMATIONS = 1;

      const mockSave = jest.fn().mockResolvedValue(true);
      const order = {
        id: 100,
        symbol: 'BTC_USDT',
        side: 'buy',
        lifecycleStatus: 'OPEN',
        exchangeInstanceId: 'ex-1',
        exchangeOrderId: 'ex-order-100',
        isSimulated: false,
        strategyId: 42,
        activeStopLossId: null,
        filledAmount: '10',
        amount: '10',
        save: mockSave,
      };

      jest.spyOn(Order, 'findAll').mockResolvedValue([order] as any);
      jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);
      const mockExchange = {
        getPosition: jest.fn().mockResolvedValue({ size: '10', contract: 'BTC_USDT' }),
        getPriceOrders: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(mockExchange as any);

      const mockPendingProtection = {
        orderId: 'ex-order-100',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLoss: '75000',
        takeProfit: null,
        tpOrdersJson: null,
        status: 'PENDING',
      };
      jest.spyOn(PendingProtection, 'findOne').mockResolvedValue(mockPendingProtection as any);

      await (monitor as any).checkAll();

      expect(mockPlaceProtections).toHaveBeenCalled();
      expect(mockHandleClose).not.toHaveBeenCalled();
    });

    it('auto-closes only when SL re-placement also fails', async () => {
      const mockPlaceProtections = jest.fn().mockResolvedValue({ slPlaced: false, tpPlaced: false, claimed: false });
      const mockPipeline = { placeProtections: mockPlaceProtections };
      const mockGetProtectionPipeline = jest.fn().mockReturnValue(mockPipeline);
      const mockHandleClose = jest.fn();

      const monitor = new NoStopLossMonitor({
        getProtectionPipeline: mockGetProtectionPipeline,
        handleClose: mockHandleClose,
      } as any);
      (monitor as any).GRACE_MS = 0;
      (monitor as any).CONFIRM_MS = 0;
      (monitor as any).MISSING_SL_CONFIRMATIONS = 1;

      const mockSave = jest.fn().mockResolvedValue(true);
      const order = {
        id: 101,
        symbol: 'ETH_USDT',
        side: 'sell',
        lifecycleStatus: 'OPEN',
        exchangeInstanceId: 'ex-1',
        exchangeOrderId: 'ex-order-101',
        isSimulated: false,
        strategyId: 43,
        activeStopLossId: null,
        filledAmount: '5',
        amount: '5',
        save: mockSave,
      };

      jest.spyOn(Order, 'findAll').mockResolvedValue([order] as any);
      jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);
      const mockExchange = {
        getPosition: jest.fn().mockResolvedValue({ size: '-5', contract: 'ETH_USDT' }),
        getPriceOrders: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(exchangeRegistry, 'getExchange').mockReturnValue(mockExchange as any);

      const mockPendingProtection = {
        orderId: 'ex-order-101',
        symbol: 'ETH_USDT',
        side: 'sell',
        stopLoss: '2500',
        takeProfit: null,
        tpOrdersJson: null,
        status: 'PENDING',
      };
      jest.spyOn(PendingProtection, 'findOne').mockResolvedValue(mockPendingProtection as any);

      await (monitor as any).checkAll();

      expect(mockPlaceProtections).toHaveBeenCalled();
      expect(mockHandleClose).toHaveBeenCalled();
    });
  });

  describe('cancelOrphanProtections cross-order SL safety', () => {
    it('does not cancel SL when other OPEN orders exist for same symbol+side', async () => {
      const mockCancelProtections = jest.fn().mockResolvedValue(undefined);
      const mockPipeline = { cancelProtections: mockCancelProtections };
      const mockGetProtectionPipeline = jest.fn().mockReturnValue(mockPipeline);

      const monitor = new NoStopLossMonitor({
        getProtectionPipeline: mockGetProtectionPipeline,
      } as any);

      const order = {
        id: 200,
        symbol: 'BTC_USDT',
        side: 'buy',
        exchangeInstanceId: 'ex-1',
        exchangeOrderId: 'ex-order-200',
      };

      // Simulate other OPEN orders for same symbol+side
      jest.spyOn(Order, 'findAll').mockResolvedValue([
        { id: 201, symbol: 'BTC_USDT', side: 'buy', lifecycleStatus: 'OPEN' },
      ] as any);

      await (monitor as any).cancelOrphanProtections(order, {});

      expect(mockCancelProtections).not.toHaveBeenCalled();
    });

    it('cancels SL when no other OPEN orders exist for same symbol+side', async () => {
      const mockCancelProtections = jest.fn().mockResolvedValue(undefined);
      const mockPipeline = { cancelProtections: mockCancelProtections };
      const mockGetProtectionPipeline = jest.fn().mockReturnValue(mockPipeline);

      const monitor = new NoStopLossMonitor({
        getProtectionPipeline: mockGetProtectionPipeline,
      } as any);

      const order = {
        id: 201,
        symbol: 'BTC_USDT',
        side: 'buy',
        exchangeInstanceId: 'ex-1',
        exchangeOrderId: 'ex-order-201',
      };

      // No other OPEN orders
      jest.spyOn(Order, 'findAll').mockResolvedValue([]);

      await (monitor as any).cancelOrphanProtections(order, {});

      expect(mockCancelProtections).toHaveBeenCalledWith(
        'BTC_USDT', 'buy', 'ex-order-201'
      );
    });
  });
});
