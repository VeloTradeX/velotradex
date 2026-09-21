import WebSocket from 'ws';
import { LighterWsStateClient } from '../../../../src/services/exchanges/lighter/LighterWsStateClient';
import logger from '../../../../src/utils/logger';

// ---- Mock the `ws` module so connect() can be driven entirely in-process ---- //
jest.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    static instances: any[] = [];

    readyState: number = MockWebSocket.OPEN;
    handlers: Record<string, Array<(...args: any[]) => void>> = {};
    _socket: { setKeepAlive: jest.Mock };
    send: jest.Mock;
    ping: jest.Mock;
    pong: jest.Mock;
    close: jest.Mock;
    terminate: jest.Mock;

    constructor(public readonly url: string, public readonly options?: any) {
      MockWebSocket.instances.push(this);
      this.send = jest.fn();
      this.ping = jest.fn();
      this.pong = jest.fn();
      this.close = jest.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.emit('close', 1000, Buffer.alloc(0));
      });
      this.terminate = jest.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
      });
      this._socket = { setKeepAlive: jest.fn() };
    }

    on(event: string, cb: (...args: any[]) => void) {
      (this.handlers[event] = this.handlers[event] || []).push(cb);
      return this;
    }
    removeListener(event: string, cb: (...args: any[]) => void) {
      const list = this.handlers[event] || [];
      this.handlers[event] = list.filter(h => h !== cb);
      return this;
    }
    removeAllListeners(event?: string) {
      if (event) delete this.handlers[event];
      else this.handlers = {};
      return this;
    }

    emit(event: string, ...args: any[]) {
      (this.handlers[event] || []).slice().forEach(h => h(...args));
    }
  }
  return MockWebSocket;
});

type MockWS = {
  OPEN: number;
  CONNECTING: number;
  CLOSING: number;
  CLOSED: number;
  instances: any[];
};
const Mock = (WebSocket as unknown) as MockWS;

const HEARTBEAT_INTERVAL_MS = 25_000;

function authTokenProvider(): { token: string; expiresAt: number } {
  return { token: 'test-token', expiresAt: Date.now() + 600_000 };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

async function connectAndOpen(client: LighterWsStateClient): Promise<any> {
  const p = client.connect();
  p.catch(() => undefined);
  await flush();
  const inst = Mock.instances[0];
  inst.readyState = Mock.OPEN;
  inst.emit('open');
  await p;
  return inst;
}

async function msUntil(predicate: () => boolean): Promise<number> {
  let elapsed = 0;
  while (!predicate()) {
    await advance(100);
    elapsed += 100;
    if (elapsed > 200_000) throw new Error('msUntil exceeded budget');
  }
  return elapsed;
}

function sendMessage(inst: any, msg: unknown) {
  inst.emit('message', Buffer.from(JSON.stringify(msg)));
}

describe('LighterWsStateClient keepalive / reconnect', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Mock.instances = [];
    // Silence winston so it never fights with the fake timers.
    jest.spyOn(logger, 'info').mockImplementation((() => logger) as any);
    jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any);
    jest.spyOn(logger, 'error').mockImplementation((() => logger) as any);
    jest.spyOn(logger, 'debug').mockImplementation((() => logger) as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pins OS-level TCP keepalive on the underlying socket after connecting', async () => {
    const client = new LighterWsStateClient('wss://lighter.test/stream', 7, authTokenProvider);
    const inst = await connectAndOpen(client);

    expect(inst._socket.setKeepAlive).toHaveBeenCalledWith(true, 30_000);
  });

  it('sends an application-level ping while the connection is healthy and open', async () => {
    const client = new LighterWsStateClient('wss://lighter.test/stream', 7, authTokenProvider);
    const inst = await connectAndOpen(client);

    inst.send.mockClear();
    await advance(HEARTBEAT_INTERVAL_MS);

    expect(inst.send).toHaveBeenCalledWith('{"type":"ping"}');
    expect(inst.ping).toHaveBeenCalled();
  });

  it('does NOT force a reconnect while inbound traffic keeps the heartbeat fresh', async () => {
    const client = new LighterWsStateClient('wss://lighter.test/stream', 7, authTokenProvider);
    await connectAndOpen(client);

    // Simulate an active feed for ~100s: refresh heartbeat every tick before it could time out.
    for (let i = 0; i < 4; i += 1) {
      await advance(HEARTBEAT_INTERVAL_MS);
      sendMessage(Mock.instances[0], { type: 'update/account_all', orders: [], positions: [], trades: [] });
    }

    expect(Mock.instances.length).toBe(1);
  });

  it('forces a reconnect on heartbeat timeout even when the socket is not OPEN (fixes short-circuit)', async () => {
    const client = new LighterWsStateClient('wss://lighter.test/stream', 7, authTokenProvider);
    const inst = await connectAndOpen(client);

    // Half-open: silently dropped by the network/gateway. The old code returned
    // early on `readyState !== OPEN` and never reconnected. Now the watchdog must fire.
    inst.readyState = Mock.CLOSING;

    // 75s crosses the 60s timeout; +1ms lets the 0-delay reconnect timer fire.
    await advance(3 * HEARTBEAT_INTERVAL_MS + 1);
    await flush(); // let the reconnect's WebSocket constructor run

    expect(Mock.instances.length).toBe(2);
  });

  it('grows the reconnect delay across consecutive failed attempts (backoff)', async () => {
    const client = new LighterWsStateClient('wss://lighter.test/stream', 7, authTokenProvider);

    let p = client.connect();
    p.catch(() => undefined);
    await flush();
    const first = Mock.instances[0];
    first.emit('error', new Error('connection refused'));

    const delay1 = await msUntil(() => Mock.instances.length >= 2);

    await flush();
    const second = Mock.instances[1];
    second.emit('error', new Error('connection refused'));

    const delay2 = await msUntil(() => Mock.instances.length >= 3);

    expect(delay1).toBeGreaterThan(0);
    expect(delay2).toBeGreaterThan(delay1);
  });
});