import Redis from 'ioredis';
import config from '../config';
import logger, { formatError } from '../utils/logger';
import { createStageDebug, summarizeDebugMessage } from '../utils/debug';

const debugMessage = createStageDebug('message');

// 重连退避步长：每次增加 100ms
const RECONNECT_DELAY_STEP_MS = 100;
// 重连延迟上限：最多 30 秒
const RECONNECT_DELAY_CAP_MS = 30_000;

class RedisService {
  private sub: Redis;
  private pub: Redis;
  private messageHandlerBound = false;
  private channelCallbacks = new Map<string, Array<(message: any) => void>>();
  private lastErrorLogTime = 0;
  private readonly ERROR_LOG_INTERVAL = 30_000; // Log connection errors at most once per 30s

  // 连接状态追踪（供系统状态接口/前端展示使用）
  private lastError: string = '';
  private lastErrorAt: number = 0;
  private lastConnectedAt: number = 0;

  constructor() {
    const redisConfig = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      retryStrategy: (times: number) => {
        // Exponential backoff: 100ms → 200ms → 400ms → ... → max 30s
        return Math.min(times * RECONNECT_DELAY_STEP_MS, RECONNECT_DELAY_CAP_MS);
      },
      enableReadyCheck: false,
      keepAlive: 10000,
    };

    this.sub = new Redis(redisConfig);
    this.pub = new Redis(redisConfig);

    this.sub.on('connect', () => {
      logger.info('Redis Subscriber connected: ' + config.redis.host);
      this.lastConnectedAt = Date.now();
      this.startHeartbeat();
    });

    this.pub.on('connect', () => {
        logger.info('Redis Publisher connected');
        this.lastConnectedAt = Date.now();
    });

    this.sub.on('error', (err) => {
      this.trackError(err);
      this.logThrottled('Redis Subscriber error', err);
    });

    this.pub.on('error', (err) => {
        this.trackError(err);
        this.logThrottled('Redis Publisher error', err);
    });

    this.sub.on('close', () => {
        this.stopHeartbeat();
    });
  }

  private trackError(err: Error) {
    if (!err || !err.message) return;
    this.lastError = err.message;
    this.lastErrorAt = Date.now();
  }

  private logThrottled(message: string, err: Error) {
    const now = Date.now();
    if (now - this.lastErrorLogTime >= this.ERROR_LOG_INTERVAL) {
      this.lastErrorLogTime = now;
      logger.error(message, formatError(err));
    }
  }

  private heartbeatInterval: NodeJS.Timeout | null = null;

  private startHeartbeat() {
    this.stopHeartbeat();
    // Send PING every 30s to keep connection alive and verify health
    this.heartbeatInterval = setInterval(() => {
        this.sub.ping().catch(err => {
            logger.error('Redis Heartbeat (PING) failed', formatError(err));
        });
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
    }
  }

  public async waitForReady(timeoutMs: number = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    logger.info(`Waiting for Redis at ${config.redis.host}:${config.redis.port}...`);
    while (Date.now() < deadline) {
      if (this.sub.status === 'ready' && this.pub.status === 'ready') {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    logger.warn(`Redis not ready after ${timeoutMs / 1000}s, continuing anyway`);
  }

  public subscribe(channel: string, callback: (message: any) => void) {
    debugMessage('subscribing to redis channel %o', { channel });

    if (!this.messageHandlerBound) {
      this.sub.on('message', (chan: string, message: string) => {
        const callbacks = this.channelCallbacks.get(chan);
        if (callbacks) {
          try {
            const data = JSON.parse(message);
            debugMessage('redis message parsed %o', summarizeDebugMessage(data));
            for (const cb of callbacks) {
              try { cb(data); } catch (e: any) {
                logger.error('Error in redis subscriber callback', formatError(e, { channel: chan }));
              }
            }
          } catch (e: any) {
            logger.error('Error parsing message from Redis', formatError(e, { channel: chan, rawMessage: message }));
          }
        }
      });
      this.messageHandlerBound = true;
    }

    if (!this.channelCallbacks.has(channel)) {
      this.channelCallbacks.set(channel, []);
      this.sub.subscribe(channel, (err, count) => {
        if (err) {
          logger.error('Failed to subscribe to channel', formatError(err, { channel }));
          debugMessage('redis subscribe failed %o', { channel, ...formatError(err) });
        } else {
          logger.info('Subscribed successfully', { channel, count });
          debugMessage('redis subscribe succeeded %o', { channel, count });
        }
      });
    }
    this.channelCallbacks.get(channel)!.push(callback);
  }

  public async publish(channel: string, message: string) {
    // Redis 不可用时快速失败（否则 pub 客户端会无限排队，导致 /api/message/send 卡死）
    if (this.pub.status !== 'ready') {
      const err = new Error(`Redis Publisher 未连接（status: ${this.pub.status}）`);
      logger.error('Failed to publish message', formatError(err, { channel }));
      throw err;
    }
    try {
      await Promise.race([
        this.pub.publish(channel, message),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis publish timeout')), 3_000)),
      ]);
      logger.info(`Published message to ${channel}`);
    } catch (err: any) {
      logger.error('Failed to publish message', formatError(err, { channel }));
      throw err;
    }
  }

  /**
   * 当前 Redis 连接状态（非阻塞，直接读取 ioredis 状态机）。
   * 供系统状态接口 /api/status 与前端首页展示使用。
   */
  public getStatus(): {
    connected: boolean;
    ready: boolean;
    subStatus: string;
    pubStatus: string;
    lastError: string;
    lastErrorAt: number;
    lastConnectedAt: number;
  } {
    const subStatus = this.sub.status;
    const pubStatus = this.pub.status;
    const connected = subStatus === 'ready' || pubStatus === 'ready';
    return {
      connected,
      ready: subStatus === 'ready' && pubStatus === 'ready',
      subStatus,
      pubStatus,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastConnectedAt: this.lastConnectedAt,
    };
  }
}

export default new RedisService();
