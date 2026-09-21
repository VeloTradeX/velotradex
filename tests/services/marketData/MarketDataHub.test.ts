import { MarketDataHub } from '../../../src/services/marketData/MarketDataHub';
import { MarketDataStream, MarketTick } from '../../../src/services/marketData/types';

class FakeStream implements MarketDataStream {
  public started = 0;
  public stopped = 0;
  public listener: ((tick: MarketTick) => void) | null = null;

  async start(listener: (tick: MarketTick) => void): Promise<void> {
    this.started += 1;
    this.listener = listener;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

describe('MarketDataHub', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('deduplicates upstream streams per symbol', async () => {
    const streams: FakeStream[] = [];
    const hub = new MarketDataHub({
      createStream: () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
    });

    const firstListener = jest.fn();
    const secondListener = jest.fn();

    await hub.start();
    const unsubscribeFirst = hub.subscribe('BTC_USDT', firstListener);
    const unsubscribeSecond = hub.subscribe('btc_usdt', secondListener);

    expect(streams).toHaveLength(1);
    expect(streams[0].started).toBe(1);

    streams[0].listener?.({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      source: 'gate',
      receivedAt: new Date('2026-05-04T00:00:00Z'),
    });

    expect(firstListener).toHaveBeenCalledWith(expect.objectContaining({ lastPrice: '65000' }));
    expect(secondListener).toHaveBeenCalledWith(expect.objectContaining({ lastPrice: '65000' }));

    await unsubscribeFirst();
    expect(streams[0].stopped).toBe(0);

    await unsubscribeSecond();
    expect(streams[0].stopped).toBe(1);
  });

  it('returns latest ticker and stale age', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-04T00:00:00Z'));

    const hub = new MarketDataHub({ createStream: () => new FakeStream() });

    hub.ingestTick({
      symbol: 'ETH_USDT',
      lastPrice: '3200',
      source: 'gate',
      receivedAt: new Date(),
    });

    jest.advanceTimersByTime(3000);

    expect(hub.getLatestTick('eth_usdt')).toEqual(expect.objectContaining({ lastPrice: '3200' }));
    expect(hub.getTicker('ETH_USDT')).toEqual(expect.objectContaining({
      symbol: 'ETH_USDT',
      lastPrice: '3200',
      raw: expect.objectContaining({
        ageMs: 3000,
        source: 'gate',
      }),
    }));
  });
});
