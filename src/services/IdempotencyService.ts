import crypto from 'crypto';
import { Op } from 'sequelize';
import { IdempotencyKey } from '../models';
import auditService from './AuditService';
import logger, { formatError } from '../utils/logger';

// 幂等键的有效期：60 秒（分钟）
const KEY_TTL_MS = 60 * 1000;
// 过期幂等键清理间隔：30 秒
const CLEANUP_INTERVAL_MS = 30 * 1000;

export interface MessageCheckResult {
  isDuplicate: boolean;
  existingKeyId?: number;
}

export class IdempotencyService {
  private cleanupInterval: NodeJS.Timeout | null = null;

  public start(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredKeys().catch((e: any) => {
        logger.warn('[IdempotencyService] Failed to cleanup expired idempotency keys', formatError(e));
      });
    }, CLEANUP_INTERVAL_MS);

    this.cleanupInterval.unref?.();
    void this.cleanupExpiredKeys().catch((e: any) => {
      logger.warn('[IdempotencyService] Failed to cleanup expired idempotency keys on startup', formatError(e));
    });
  }

  public stop(): void {
    if (!this.cleanupInterval) return;
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }

  private getCutoffDate(): Date {
    return new Date(Date.now() - KEY_TTL_MS);
  }

  public async cleanupExpiredKeys(): Promise<number> {
    const count = await IdempotencyKey.destroy({
      where: {
        firstSeenAt: { [Op.lt]: this.getCutoffDate() },
      },
    });

    if (count > 0) {
      logger.info('[IdempotencyService] Cleaned expired idempotency keys', {
        count,
        ttlMs: KEY_TTL_MS,
      });
    }

    return count;
  }

  /**
   * 检查消息是否重复（第一层幂等）
   * @param channelId 频道 ID
   * @param content 消息内容
   * @returns isDuplicate: true = 重复，false = 新消息
   */
  public async checkMessage(
    channelId: string,
    content: string
  ): Promise<MessageCheckResult> {
    // content 为空时跳过幂等检查
    if (!content || content.trim() === '') {
      return { isDuplicate: false };
    }

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const existing = await IdempotencyKey.findOne({
      where: {
        channelId,
        contentHash,
        firstSeenAt: { [Op.gte]: this.getCutoffDate() },
      },
    });

    if (existing) {
      logger.info(`[IdempotencyService] Duplicate message detected: channel=${channelId}, hash=${contentHash.slice(0, 8)}`);
      return { isDuplicate: true, existingKeyId: existing.id };
    }

    return { isDuplicate: false };
  }

  /**
   * 写入幂等键（在 Strategy 创建成功后调用）
   */
  public async writeKey(
    channelId: string,
    content: string,
    messageId: number | null,
    strategyId: number
  ): Promise<void> {
    if (!content || content.trim() === '') return;

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    try {
      await IdempotencyKey.create({
        channelId,
        contentHash,
        firstSeenAt: new Date(),
        messageId: messageId ?? null,
        strategyId,
      });
    } catch (e: unknown) {
      // UNIQUE 冲突时忽略（并发写入情况）
      if ((e as any).name !== 'SequelizeUniqueConstraintError') {
        logger.warn('[IdempotencyService] Failed to write idempotency key', formatError(e));
      }
    }
  }

  /**
   * 记录消息幂等命中的审计日志
   */
  public async logDuplicate(
    channelId: string,
    content: string,
    messageId?: number
  ): Promise<void> {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    await auditService.log(0, 'MESSAGE_DEDUPED', {
      channelId,
      messageId,
      contentHash,
    });
  }
}

export default new IdempotencyService();
