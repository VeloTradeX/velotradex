import { GateIOWSEventRouter } from '../../../src/services/exchanges/GateIOWSEventRouter';

jest.mock('../../../src/models', () => ({
  Order: {
    findAll: jest.fn(),
  },
}));

jest.mock('../../../src/services/AuditService', () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    logByExchangeOrderId: jest.fn().mockResolvedValue(undefined),
    logBySymbol: jest.fn().mockResolvedValue(undefined),
  },
}));

const { Order } = jest.requireMock('../../../src/models');

describe('GateIOWSEventRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes order updates through GateIOExchange persistence only', () => {
    const exchange = {
      handleWsOrderUpdate: jest.fn(),
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any);

    router.route({
      channel: 'futures.orders',
      result: {
        id: 'ex-123',
        contract: 'BTC_USDT',
        status: 'finished',
        left: '3',
        fill_price: '100',
        price: '100',
        size: '5',
      },
    });

    expect(exchange.handleWsOrderUpdate).toHaveBeenCalledTimes(1);
    expect(persistence.handleOrderUpdate).not.toHaveBeenCalled();
  });
});

describe('GateIOWSEventRouter REST re-verification', () => {
  beforeEach(async () => {
    // Clear mocks and wait for any lingering async from previous tests
    jest.clearAllMocks();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('deduplicates duplicate closed-position events while cleanup is in flight', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'buy', lifecycleStatus: 'OPEN', status: 'open', save },
      { side: 'buy', lifecycleStatus: 'PROTECTED', status: 'open', save },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      orderPersistenceHandler: {
        protectionPipeline: {
          cancelProtections,
        },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    // Disable REST confirm for this legacy test to keep it fast
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmEnabled: false,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });
    router.route({
      channel: 'futures.positions',
      result: { contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for fire-and-forget async to fully complete
    await new Promise(resolve => setTimeout(resolve, 300));

    // Only 'buy' side has tracked orders, so cancelProtections is called once for 'buy'
    expect(cancelProtections).toHaveBeenCalledTimes(1);
    expect(cancelProtections).toHaveBeenNthCalledWith(1, 'BTC_USDT', 'buy');
    expect(save).toHaveBeenCalledTimes(2);
    // Only 1 call because the duplicate is skipped by closeCleanupInFlight
    expect(Order.findAll).toHaveBeenCalledTimes(1);
  });

  it('skips close cleanup when REST confirms position is still open after WS size=0', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      // REST returns a non-zero position — position has reopened
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'ETH_USDT', size: '-50', entryPrice: '3500' },
      ]),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'ETH_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for async to complete
    await new Promise(resolve => setTimeout(resolve, 300));

    // REST confirmed position is still open → no cleanup
    expect(exchange.getPositions).toHaveBeenCalledTimes(1);
    expect(cancelProtections).not.toHaveBeenCalled();
  });

  it('proceeds with close cleanup when REST confirms position is closed after WS size=0', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      // REST returns no positions — position confirmed closed on both verifications
      getPositions: jest.fn().mockResolvedValue([]),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'SOL_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for async to complete (double REST verification adds extra delay)
    await new Promise(resolve => setTimeout(resolve, 800));

    // Both first and second REST verifications confirm position is closed
    expect(exchange.getPositions).toHaveBeenCalledTimes(2);
    expect(cancelProtections).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it('falls back to WS-only cleanup when REST getPositions fails', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      getPositions: jest.fn().mockRejectedValue(new Error('REST timeout')),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'DOGE_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for async to complete (double REST verification adds extra delay)
    await new Promise(resolve => setTimeout(resolve, 800));

    // Both REST calls failed → fall through to WS-based cleanup
    expect(exchange.getPositions).toHaveBeenCalledTimes(2);
    expect(cancelProtections).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it('skips REST confirmation when restConfirmEnabled is false', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'buy', lifecycleStatus: 'OPEN', status: 'open', save },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      getPositions: jest.fn(),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmEnabled: false,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'XRP_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // REST confirmation was not called
    expect(exchange.getPositions).not.toHaveBeenCalled();
    // Cleanup proceeds immediately (no delay)
    expect(cancelProtections).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it('defers close detection when pending open is in flight for the symbol', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    const pendingOpenSymbols = new Set<string>(['BTC_USDT']);
    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      pendingOpenSymbols,
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
      pendingOpenDeferMs: 500,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait briefly — close detection should be deferred, not executed yet
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(cancelProtections).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    // Clear the pending open flag and wait for the deferred check to fire
    pendingOpenSymbols.delete('BTC_USDT');
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Now the deferred check should have completed cleanup
    expect(cancelProtections).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it('aborts close cleanup on second REST verification when position reopens', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    let callCount = 0;
    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      // First REST call: size=0 (confirmed closed). Second REST call: position reopened.
      getPositions: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([]);
        return Promise.resolve([{ symbol: 'ETH_USDT', size: '-50', entryPrice: '3500' }]);
      }),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'ETH_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for double REST verification to complete
    await new Promise(resolve => setTimeout(resolve, 800));

    // Second REST verification found position reopened → abort cleanup
    expect(exchange.getPositions).toHaveBeenCalledTimes(2);
    expect(cancelProtections).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('skips close cleanup in hedge mode when zero-size leg comes first but other leg is open', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      // Hedge mode: Gate.io returns both long and short legs.
      // The zero-size long leg comes first, but the short leg has size=-219.
      // Old code using find() would pick the zero-size leg and falsely confirm closed.
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '0', entryPrice: '0', leverage: '0' },    // long leg (empty)
        { symbol: 'BTC_USDT', size: '-219', entryPrice: '66802.5', leverage: '0' }, // short leg (active)
      ]),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for REST verification to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // REST verification should find the non-zero leg and skip close cleanup
    expect(exchange.getPositions).toHaveBeenCalledTimes(1);
    expect(cancelProtections).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('proceeds with close cleanup in hedge mode when both legs are zero-size', async () => {
    const cancelProtections = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    Order.findAll.mockResolvedValue([
      { side: 'sell', lifecycleStatus: 'PROTECTED', status: 'open', save, strategyId: 100, exchangeOrderId: 'ex-1', id: 1 },
    ]);

    const exchange = {
      handleWsOrderUpdate: jest.fn(),
      // Hedge mode: both legs are zero-size — position truly closed
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '0', entryPrice: '0', leverage: '0' },
        { symbol: 'BTC_USDT', size: '0', entryPrice: '0', leverage: '0' },
      ]),
      orderPersistenceHandler: {
        protectionPipeline: { cancelProtections },
      },
    };
    const persistence = {
      handleOrderUpdate: jest.fn().mockResolvedValue(undefined),
      handlePositionUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const router = new GateIOWSEventRouter(exchange, persistence as any, {
      restConfirmDelayMs: 0,
      restConfirmEnabled: true,
    });

    router.route({
      channel: 'futures.positions',
      result: { contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', unrealised_pnl: '0' },
    });

    // Wait for double REST verification to complete
    await new Promise(resolve => setTimeout(resolve, 800));

    // Both REST verifications confirm all legs are zero → proceed with cleanup
    expect(exchange.getPositions).toHaveBeenCalledTimes(2);
    expect(cancelProtections).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });
});
