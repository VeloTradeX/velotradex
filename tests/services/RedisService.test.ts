import redisService from '../../src/services/RedisService';
import logger from '../../src/utils/logger';

jest.mock('ioredis', () => {
  class MockRedis {
    static createdConfigs: any[] = [];
    status = 'wait';
    handlers = new Map<string, Array<(...args: any[]) => void>>();

    constructor(config: any) {
      MockRedis.createdConfigs.push(config);
    }

    on = jest.fn((event: string, cb: (...args: any[]) => void) => {
      const list = this.handlers.get(event) || [];
      list.push(cb);
      this.handlers.set(event, list);
    });

    subscribe = jest.fn((_channel: string, cb?: (err: Error | null, count: number) => void) => {
      if (cb) cb(null, 1);
      return Promise.resolve(1);
    });

    publish = jest.fn(() => Promise.resolve(1));
    ping = jest.fn(() => Promise.resolve('PONG'));

    emit(event: string, ...args: any[]) {
      for (const cb of this.handlers.get(event) || []) {
        cb(...args);
      }
    }
  }

  return { __esModule: true, default: MockRedis };
});

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    redis: { host: 'redis.local', port: 6380, password: 'secret', db: 2 },
  },
}));

jest.mock('../../src/utils/logger', () => {
  const formatError = (err: any, businessCtx?: Record<string, any>) => {
    if (err instanceof Error) {
      return {
        errorMessage: err.message,
        errorName: err.name,
        errorStack: err.stack,
        ...businessCtx,
      };
    }
    return { error: String(err), ...businessCtx };
  };
  return {
    __esModule: true,
    formatError,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

jest.mock('../../src/utils/debug', () => ({
  createStageDebug: jest.fn(() => jest.fn()),
  summarizeDebugMessage: jest.fn((message: any) => message),
}));

describe('RedisService', () => {
  let sub: any;
  let pub: any;

  const formattedError = (message: string, ctx: Record<string, any> = {}) => ({
    errorMessage: message,
    errorName: 'Error',
    errorStack: expect.any(String),
    ...ctx,
  });

  const getMessageHandler = () => {
    const handlers = sub.handlers.get('message') || [];
    return handlers[handlers.length - 1] as (chan: string, message: string) => void;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    sub = (redisService as any).sub;
    pub = (redisService as any).pub;
    sub.status = 'wait';
    pub.status = 'wait';

    // Re-establish default implementations in case a previous test overrode them.
    sub.subscribe.mockImplementation(
      (_channel: string, cb?: (err: Error | null, count: number) => void) => {
        if (cb) cb(null, 1);
        return Promise.resolve(1);
      }
    );
    sub.publish.mockImplementation(() => Promise.resolve(1));
    pub.publish.mockImplementation(() => Promise.resolve(1));
    sub.ping.mockImplementation(() => Promise.resolve('PONG'));

    // Reset singleton subscription state between tests.
    (redisService as any).messageHandlerBound = false;
    (redisService as any).channelCallbacks = new Map();
    (redisService as any).lastErrorLogTime = 0;
    sub.handlers.delete('message');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates separate subscriber and publisher clients from config', () => {
    const configs = (sub.constructor as any).createdConfigs;

    expect(configs).toHaveLength(2);
    expect(sub).not.toBe(pub);
    for (const cfg of configs) {
      expect(cfg.host).toBe('redis.local');
      expect(cfg.port).toBe(6380);
      expect(cfg.password).toBe('secret');
      expect(cfg.db).toBe(2);
      expect(cfg.enableReadyCheck).toBe(false);
      // Exponential backoff: times * 100ms, capped at 30s
      expect(cfg.retryStrategy(3)).toBe(300);
      expect(cfg.retryStrategy(400)).toBe(30000);
    }
  });

  it('logs connections and runs a 30s ping heartbeat until the subscriber closes', async () => {
    jest.useFakeTimers();

    sub.emit('connect');
    pub.emit('connect');

    expect(logger.info).toHaveBeenCalledWith('Redis Subscriber connected: redis.local');
    expect(logger.info).toHaveBeenCalledWith('Redis Publisher connected');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(sub.ping).toHaveBeenCalledTimes(1);

    sub.emit('close');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sub.ping).toHaveBeenCalledTimes(1);
  });

  it('throttles subscriber error logs to at most once per 30s', () => {
    sub.emit('error', new Error('boom-1'));
    sub.emit('error', new Error('boom-2'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Redis Subscriber error',
      formattedError('boom-1')
    );
  });

  it('waitForReady resolves without sleeping when both clients are ready', async () => {
    sub.status = 'ready';
    pub.status = 'ready';

    await redisService.waitForReady();

    expect(logger.info).toHaveBeenCalledWith('Waiting for Redis at redis.local:6380...');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('waitForReady continues with a warning after the timeout expires', async () => {
    jest.useFakeTimers();

    const promise = redisService.waitForReady(2000);
    await jest.advanceTimersByTimeAsync(2500);
    await promise;

    expect(logger.warn).toHaveBeenCalledWith('Redis not ready after 2s, continuing anyway');
  });

  it('subscribes to a channel and registers the callback', () => {
    const callback = jest.fn();

    redisService.subscribe('chan-1', callback);

    expect(sub.subscribe).toHaveBeenCalledWith('chan-1', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith('Subscribed successfully', { channel: 'chan-1', count: 1 });
  });

  it('reuses an existing subscription when subscribing to the same channel again', () => {
    redisService.subscribe('chan-1', jest.fn());
    redisService.subscribe('chan-1', jest.fn());

    expect(sub.subscribe).toHaveBeenCalledTimes(1);
  });

  it('logs failed subscriptions', () => {
    sub.subscribe.mockImplementation(
      (_channel: string, cb?: (err: Error | null, count: number) => void) => {
        if (cb) cb(new Error('sub failed'), 0);
        return Promise.resolve(0);
      }
    );

    redisService.subscribe('bad-chan', jest.fn());

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to subscribe to channel',
      formattedError('sub failed', { channel: 'bad-chan' })
    );
  });

  it('dispatches parsed messages only to callbacks of the matching channel', () => {
    const callback1 = jest.fn();
    const callback2 = jest.fn();

    redisService.subscribe('chan-1', callback1);
    redisService.subscribe('chan-2', callback2);

    getMessageHandler()('chan-1', JSON.stringify({ content: 'hello' }));

    expect(callback1).toHaveBeenCalledWith({ content: 'hello' });
    expect(callback2).not.toHaveBeenCalled();
  });

  it('keeps other callbacks running and logs when one callback throws', () => {
    const bad = jest.fn(() => {
      throw new Error('cb exploded');
    });
    const good = jest.fn();

    redisService.subscribe('chan-1', bad);
    redisService.subscribe('chan-1', good);

    expect(() => getMessageHandler()('chan-1', JSON.stringify({ ok: true }))).not.toThrow();

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith({ ok: true });
    expect(logger.error).toHaveBeenCalledWith(
      'Error in redis subscriber callback',
      formattedError('cb exploded', { channel: 'chan-1' })
    );
  });

  it('logs and skips callbacks when a message is not valid JSON', () => {
    const callback = jest.fn();

    redisService.subscribe('chan-1', callback);

    expect(() => getMessageHandler()('chan-1', 'not-json')).not.toThrow();

    expect(callback).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Error parsing message from Redis',
      expect.objectContaining({
        errorName: 'SyntaxError',
        channel: 'chan-1',
        rawMessage: 'not-json',
      })
    );
  });

  it('publishes messages through the publisher client', async () => {
    pub.status = 'ready';
    await redisService.publish('chan-9', 'payload');

    expect(pub.publish).toHaveBeenCalledWith('chan-9', 'payload');
    expect(sub.publish).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Published message to chan-9');
  });

  it('logs and rethrows publish failures', async () => {
    pub.status = 'ready';
    pub.publish.mockImplementation(() => Promise.reject(new Error('publish down')));

    await expect(redisService.publish('chan-9', 'payload')).rejects.toThrow('publish down');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish message',
      formattedError('publish down', { channel: 'chan-9' })
    );
  });

  it('fails fast when redis publisher is not connected', async () => {
    pub.status = 'reconnecting';

    await expect(redisService.publish('chan-9', 'payload')).rejects.toThrow('未连接');

    expect(pub.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish message',
      expect.objectContaining({ channel: 'chan-9' })
    );
  });
});
