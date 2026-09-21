import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

class StatsService {
  private redis: Redis;
  private readonly KEY_TOTAL_MSG = 'stats:msg:total';
  private readonly KEY_MATCHED_MSG = 'stats:msg:matched';
  private readonly KEY_PARSED_STRATEGY = 'stats:strategy:parsed';

  constructor() {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      // 关键：Redis 不可用时快速失败而不是无限排队，避免 /api/stats 等接口被卡死。
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // 抑制 ioredis 的 "Unhandled error event" 噪音（Redis 不可用时连接错误会被上面的 try/catch 兜底）
    this.redis.on('error', (err: any) => {
      logger.debug('[StatsService] redis client error', { message: err?.message || String(err) });
    });
  }

  public async incrementTotalMsg() {
    try {
      await this.redis.incr(this.KEY_TOTAL_MSG);
    } catch (e: any) {
      logger.warn('[StatsService] incrementTotalMsg failed (Redis 不可用?)', e?.message || e);
    }
  }

  public async incrementMatchedMsg() {
    try {
      await this.redis.incr(this.KEY_MATCHED_MSG);
    } catch (e: any) {
      logger.warn('[StatsService] incrementMatchedMsg failed (Redis 不可用?)', e?.message || e);
    }
  }

  public async incrementParsedStrategy() {
    try {
      await this.redis.incr(this.KEY_PARSED_STRATEGY);
    } catch (e: any) {
      logger.warn('[StatsService] incrementParsedStrategy failed (Redis 不可用?)', e?.message || e);
    }
  }

  public async getStats() {
    try {
      const [total, matched, parsed] = await Promise.all([
        this.redis.get(this.KEY_TOTAL_MSG),
        this.redis.get(this.KEY_MATCHED_MSG),
        this.redis.get(this.KEY_PARSED_STRATEGY),
      ]);

      return {
        totalMessages: parseInt(total || '0', 10),
        matchedMessages: parseInt(matched || '0', 10),
        parsedStrategies: parseInt(parsed || '0', 10),
      };
    } catch (e: any) {
      // Redis 不可用时降级返回 0，避免阻塞 /api/stats 请求
      logger.warn('[StatsService] getStats failed (Redis 不可用?)，降级返回 0', e?.message || e);
      return {
        totalMessages: 0,
        matchedMessages: 0,
        parsedStrategies: 0,
      };
    }
  }
}

export default new StatsService();
