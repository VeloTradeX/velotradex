import { GateMarketDataStream, GateTickerPayload } from '../../../src/services/marketData/GateMarketDataStream';
import WebSocket from 'ws';

jest.mock('ws');

function makeFetcher(response: GateTickerPayload | GateTickerPayload[] | null) {
  return jest.fn().mockResolvedValue(response);
}

describe('GateMarketDataStream', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    { name: 'array', data: [{ contract: 'BTC_USDT', last: '', last_price: '65000', mark_price: '64990' }] },
    { name: 'object', data: { contract: 'ETH_USDT', last: '', last_price: '3200', mark_price: '3199' } },
  ])('falls back from empty last to last_price for $name payloads', async ({ data }) => {
    const fetcher = makeFetcher(data);
    const listener = jest.fn();
    const symbol = Array.isArray(data) ? data[0].contract : data.contract;
    const expectedLastPrice = Array.isArray(data) ? data[0].last_price : data.last_price;
    const stream = new GateMarketDataStream(symbol, {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      symbol,
      lastPrice: expectedLastPrice,
      source: 'gate',
    }));
  });

  it('publishes tick via injected fetcher', async () => {
    const fetcher = makeFetcher({ contract: 'BTC_USDT', last: '65000', mark_price: '64990', index_price: '64800' });
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(fetcher).toHaveBeenCalledWith('BTC_USDT');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      markPrice: '64990',
      indexPrice: '64800',
      source: 'gate',
    }));
  });

  it('ignores invalid prices (zero, negative, NaN)', async () => {
    const fetcher = makeFetcher({ contract: 'BTC_USDT', last: '0', last_price: '-5', mark_price: 'NaN' });
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores null fetcher response', async () => {
    const fetcher = makeFetcher(null);
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores empty array fetcher response', async () => {
    const fetcher = makeFetcher([]);
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not schedule or emit after stop during an in-flight first poll', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setInterval', 'clearInterval', 'clearImmediate', 'nextTick'] });
    const baselineTimerCount = jest.getTimerCount();
    let resolvePoll!: (value: any) => void;
    const fetcher = jest.fn().mockReturnValueOnce(new Promise(resolve => {
      resolvePoll = resolve;
    }));
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 1000,
      useWebSocket: false,
    });

    const startPromise = stream.start(listener);
    await stream.stop();

    resolvePoll({ contract: 'BTC_USDT', last: '65000', mark_price: '64990' });
    await startPromise;

    expect(listener).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(baselineTimerCount);

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not overlap slow polls', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setInterval', 'clearInterval', 'clearImmediate', 'nextTick'] });
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ contract: 'BTC_USDT', last: '65000', mark_price: '64990' });
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 1000,
      useWebSocket: false,
    });

    await stream.start(listener);
    expect(fetcher).toHaveBeenCalledTimes(1);

    let resolveSecondPoll!: (value: any) => void;
    fetcher.mockReturnValueOnce(new Promise(resolve => {
      resolveSecondPoll = resolve;
    }));
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveSecondPoll({ contract: 'BTC_USDT', last: '65100', mark_price: '65090' });
    await Promise.resolve();
    await Promise.resolve();
    await stream.stop();
  });

  it('logs warning on fetcher error but does not throw', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('network failure'));
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      intervalMs: 60_000,
      useWebSocket: false,
    });

    await stream.start(listener);
    await stream.stop();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('GateMarketDataStream WS mode', () => {
  let mockWsInstance: any;
  let mockWsOn: jest.Mock;
  let mockWsSend: jest.Mock;

  beforeEach(() => {
    mockWsOn = jest.fn();
    mockWsSend = jest.fn();
    mockWsInstance = {
      on: mockWsOn,
      send: mockWsSend,
      removeAllListeners: jest.fn(),
      terminate: jest.fn(),
      readyState: 1, // WebSocket.OPEN
    };
    (WebSocket as any).mockImplementation(() => mockWsInstance);
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it('connects WS and subscribes to futures.tickers on start', async () => {
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: jest.fn(),
      useWebSocket: true,
    });

    await stream.start(listener);

    // Simulate WS open event
    const openHandler = mockWsOn.mock.calls.find(c => c[0] === 'open')?.[1];
    openHandler?.();

    expect(mockWsSend).toHaveBeenCalledWith(
      expect.stringContaining('"channel":"futures.tickers"'),
    );
    expect(mockWsSend).toHaveBeenCalledWith(
      expect.stringContaining('"BTC_USDT"'),
    );

    await stream.stop();
  });

  it('calls listener with parsed tick from WS update', async () => {
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: jest.fn(),
      useWebSocket: true,
    });

    await stream.start(listener);

    const openHandler = mockWsOn.mock.calls.find(c => c[0] === 'open')?.[1];
    openHandler?.();

    const messageHandler = mockWsOn.mock.calls.find(c => c[0] === 'message')?.[1];
    messageHandler?.(Buffer.from(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.tickers',
      event: 'update',
      result: [{
        contract: 'BTC_USDT',
        last: '65000',
        mark_price: '64990',
        index_price: '64800',
      }],
    })));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      markPrice: '64990',
      indexPrice: '64800',
      source: 'gate',
    }));

    await stream.stop();
  });

  it('ignores WS ticker for different symbol', async () => {
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: jest.fn(),
      useWebSocket: true,
    });

    await stream.start(listener);

    const openHandler = mockWsOn.mock.calls.find(c => c[0] === 'open')?.[1];
    openHandler?.();

    const messageHandler = mockWsOn.mock.calls.find(c => c[0] === 'message')?.[1];
    messageHandler?.(Buffer.from(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.tickers',
      event: 'update',
      result: [{
        contract: 'ETH_USDT',
        last: '3200',
        mark_price: '3199',
      }],
    })));

    expect(listener).not.toHaveBeenCalled();

    await stream.stop();
  });

  it('falls back to HTTP polling when WS closes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setInterval', 'clearInterval', 'clearImmediate', 'nextTick'] });
    const fetcher = jest.fn().mockResolvedValue({
      contract: 'BTC_USDT', last: '65000', mark_price: '64990',
    });
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      useWebSocket: true,
      intervalMs: 1000,
    });

    await stream.start(listener);

    const openHandler = mockWsOn.mock.calls.find(c => c[0] === 'open')?.[1];
    openHandler?.();

    const closeHandler = mockWsOn.mock.calls.find(c => c[0] === 'close')?.[1];
    closeHandler?.();

    await jest.advanceTimersByTimeAsync(1000);

    expect(fetcher).toHaveBeenCalledWith('BTC_USDT');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      source: 'gate',
    }));

    await stream.stop();
    jest.useRealTimers();
  });

  it('uses HTTP polling when useWebSocket is false', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      contract: 'BTC_USDT', last: '65000', mark_price: '64990',
    });
    const listener = jest.fn();
    const stream = new GateMarketDataStream('BTC_USDT', {
      fetchTicker: fetcher,
      useWebSocket: false,
      intervalMs: 60_000,
    });

    await stream.start(listener);
    await stream.stop();

    expect(fetcher).toHaveBeenCalledWith('BTC_USDT');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      source: 'gate',
    }));
    expect(WebSocket).not.toHaveBeenCalled();
  });
});
