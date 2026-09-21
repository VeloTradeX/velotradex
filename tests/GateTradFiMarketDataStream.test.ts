import {
  GateTradFiMarketDataStream,
  toTradFiSymbol,
  fromTradFiSymbol,
} from '../src/services/marketData/GateTradFiMarketDataStream';

/** 可注入的假 WebSocket：手动触发 open/message/close，记录发送帧 */
class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, (...args: any[]) => void> = {};

  on(event: string, cb: (...args: any[]) => void): this {
    this.handlers[event] = cb;
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.readyState = 0;
  }
  removeAllListeners(): void {
    this.handlers = {};
  }
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.handlers.open?.();
  }
  emitMessage(data: any): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.handlers.message?.(Buffer.from(payload));
  }
  emitClose(): void {
    this.readyState = 0;
    this.handlers.close?.();
  }
  emitError(err: Error): void {
    this.handlers.error?.(err);
  }
}

describe('GateTradFiMarketDataStream', () => {
  let sockets: FakeWebSocket[] = [];

  const createStream = (opts: any = {}): GateTradFiMarketDataStream => {
    const stream = new GateTradFiMarketDataStream({
      wsUrl: 'wss://test/tradfi',
      pingIntervalMs: 100000,
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
      ...opts,
      createWebSocket: (() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as any;
      }) as any,
    });
    return stream;
  };

  const parsedFrames = (ws: FakeWebSocket): any[] => ws.sent.map(f => JSON.parse(f));

  beforeEach(() => {
    sockets = [];
  });

  afterEach(async () => {
    // 清理未停止的流，避免残留定时器
    // （各用例内已 stop；此处兜底）
  });

  it('maps internal BASE_USDT symbols to tradfi BASEUSD and back', () => {
    expect(toTradFiSymbol('XAU_USDT')).toBe('XAUUSD');
    expect(toTradFiSymbol('BTC_USDT')).toBe('BTCUSD');
    expect(toTradFiSymbol('xauusdt')).toBe('XAUUSD');
    expect(fromTradFiSymbol('XAUUSD')).toBe('XAU_USDT');
    expect(fromTradFiSymbol('BTCUSD')).toBe('BTC_USDT');
    expect(fromTradFiSymbol('XAGUSD')).toBe('XAG_USDT');
  });

  it('subscribes tradfi.tickers with markets payload on connect', async () => {
    const stream = createStream();
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    const frames = parsedFrames(ws);
    expect(frames).toContainEqual({
      time: expect.any(Number),
      channel: 'tradfi.tickers',
      event: 'subscribe',
      payload: { markets: ['XAUUSD'] },
    });
    await stream.stop();
  });

  it('subscribes tradfi.order_book additionally when enabled', async () => {
    const stream = createStream({ subscribeOrderBook: true });
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    const frames = parsedFrames(ws);
    expect(frames).toContainEqual({
      time: expect.any(Number),
      channel: 'tradfi.order_book',
      event: 'subscribe',
      payload: ['XAUUSD'],
    });
    await stream.stop();
  });

  it('forwards ticker updates to listeners with internal symbol', async () => {
    const stream = createStream();
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    const ticks: any[] = [];
    const cleanup = stream.onTick('XAU_USDT', tick => ticks.push(tick));

    ws.emitMessage({
      time: 1768362181,
      channel: 'tradfi.tickers',
      event: 'update',
      result: [{ timestamp: '1768341600', symbol: 'XAUUSD', last_price: '4622.95', open_price: '4587.16' }],
    });

    expect(ticks).toHaveLength(1);
    expect(ticks[0].symbol).toBe('XAU_USDT');
    expect(ticks[0].lastPrice).toBe('4622.95');
    expect(stream.getLatestTick('XAU_USDT')?.lastPrice).toBe('4622.95');

    cleanup();
    await stream.stop();
  });

  it('ignores ticker updates for symbols not subscribed', async () => {
    const stream = createStream();
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    const ticks: any[] = [];
    stream.onTick('XAU_USDT', tick => ticks.push(tick));

    ws.emitMessage({
      time: 1768362181,
      channel: 'tradfi.tickers',
      event: 'update',
      result: [{ timestamp: '1768341600', symbol: 'BTCUSD', last_price: '60000' }],
    });

    expect(ticks).toHaveLength(0);
    await stream.stop();
  });

  it('exposes best bid/ask from order_book channel', async () => {
    const stream = createStream({ subscribeOrderBook: true });
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    ws.emitMessage({
      time: 1768372119,
      channel: 'tradfi.order_book',
      event: 'update',
      result: [{ time: 1768372119, symbol: 'XAUUSD', bid: '4633.24', ask: '4633.33' }],
    });

    expect(stream.getBestPrices('XAU_USDT')).toEqual({
      bid: '4633.24',
      ask: '4633.33',
      at: expect.any(Date),
    });
    await stream.stop();
  });

  it('reconnects and resubscribes all symbols', async () => {
    // 只 fake setTimeout，避免污染 setImmediate/setInterval（Jest 30 的 useRealTimers 无法还原它们）
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setInterval', 'clearInterval', 'clearImmediate', 'nextTick'] });
    try {
      const stream = createStream();
      await stream.start();
      stream.subscribe('XAU_USDT');
      stream.subscribe('BTC_USDT');

      const ws1 = sockets[0];
      ws1.emitOpen();
      expect(sockets).toHaveLength(1);

      ws1.emitClose();
      jest.advanceTimersByTime(5000);

      expect(sockets.length).toBeGreaterThanOrEqual(2);
      const ws2 = sockets[1];
      ws2.emitOpen();

      const subscribeFrames = parsedFrames(ws2).filter(
        f => f.event === 'subscribe' && f.channel === 'tradfi.tickers',
      );
      expect(subscribeFrames.map(f => f.payload.markets[0]).sort()).toEqual(['BTCUSD', 'XAUUSD']);

      await stream.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends unsubscribe when a symbol is removed', async () => {
    const stream = createStream();
    await stream.start();
    stream.subscribe('XAU_USDT');
    const ws = sockets[0];
    ws.emitOpen();

    stream.unsubscribe('XAU_USDT');

    const frames = parsedFrames(ws);
    expect(frames).toContainEqual({
      time: expect.any(Number),
      channel: 'tradfi.tickers',
      event: 'unsubscribe',
      payload: { markets: ['XAUUSD'] },
    });
    expect(stream.getSubscribedSymbols()).toHaveLength(0);
    await stream.stop();
  });
});
