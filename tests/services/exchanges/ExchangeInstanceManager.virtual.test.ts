jest.mock('../../../src/services/marketData/MarketDataHub', () => ({
  MarketDataHub: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
    getTicker: jest.fn(),
    getLatestTick: jest.fn(),
  })),
}));

jest.mock('../../../src/services/marketData/GateMarketDataStream', () => ({
  GateMarketDataStream: jest.fn(),
}));

jest.mock('../../../src/services/exchanges/virtual/VirtualGateExchange', () => ({
  VirtualGateExchange: jest.fn().mockImplementation((config: any) => ({
    id: config.id,
    name: config.name,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getWebSocketStats: jest.fn().mockReturnValue({ isConnected: true, type: 'virtual_gate' }),
  })),
}));

describe('ExchangeInstanceManager virtual_gate registration', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('registers virtual_gate exchange instances', async () => {
    const manager = (await import('../../../src/services/exchanges/ExchangeInstanceManager')).default as any;
    await manager.registerExchange({
      id: 'virtual_1',
      type: 'virtual_gate',
      name: 'Virtual 1',
      config: JSON.stringify({ initialBalance: '10000', maxTickAgeMs: 10000 }),
      status: 'active',
    });

    const exchange = manager.getExchange('virtual_1');
    expect(exchange.id).toBe('virtual_1');
    expect(exchange.name).toBe('Virtual 1');
  });
});
