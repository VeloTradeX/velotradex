import { sequelize, ExchangeConnectionLog } from '../models';
import logger, { formatError } from '../utils/logger';

export interface DisconnectRecordInput {
  exchangeInstanceId: string;
  exchangeName?: string | null;
  exchangeType?: string | null;
  reason?: string | null;
}

/**
 * ExchangeConnectionLogService —— 交易所连接断开历史记录服务。
 *
 * 每次「连接断开 → 重连成功」记为一个断连事件（一行）：
 *  - recordDisconnect：断开时写入，若该交易所已存在未闭合（reconnectedAt 为空）的断连记录，
 *    则只更新原因与名称快照，避免一次断线期间反复触发产生大量记录；
 *  - recordReconnect：重连成功时闭合最近的未闭合记录并回填 durationMs（精确记录持续时间）。
 *
 * 所有写库失败仅记日志，绝不影响交易所运行。
 */
class ExchangeConnectionLogService {
  public async recordDisconnect(input: DisconnectRecordInput): Promise<void> {
    try {
      const existing = await ExchangeConnectionLog.findOne({
        where: {
          exchangeInstanceId: input.exchangeInstanceId,
          eventType: 'disconnect',
          reconnectedAt: null,
        },
        order: [['disconnectedAt', 'DESC']],
      });

      if (existing) {
        if (input.reason) existing.reason = input.reason;
        if (input.exchangeName) existing.exchangeName = input.exchangeName;
        if (input.exchangeType) existing.exchangeType = input.exchangeType;
        await existing.save();
        return;
      }

      await ExchangeConnectionLog.create({
        exchangeInstanceId: input.exchangeInstanceId,
        exchangeName: input.exchangeName ?? null,
        exchangeType: input.exchangeType ?? null,
        eventType: 'disconnect',
        reason: input.reason ?? null,
        disconnectedAt: new Date(),
        reconnectedAt: null,
        durationMs: null,
      });
    } catch (err) {
      logger.warn(
        '[ExchangeConnectionLog] recordDisconnect failed',
        formatError(err, { exchangeInstanceId: input.exchangeInstanceId })
      );
    }
  }

  public async recordReconnect(exchangeInstanceId: string): Promise<void> {
    try {
      const open = await ExchangeConnectionLog.findOne({
        where: {
          exchangeInstanceId,
          eventType: 'disconnect',
          reconnectedAt: null,
        },
        order: [['disconnectedAt', 'DESC']],
      });

      if (!open) return;

      const reconnectedAt = new Date();
      const durationMs = Math.max(
        0,
        reconnectedAt.getTime() - new Date(open.disconnectedAt).getTime()
      );
      open.reconnectedAt = reconnectedAt;
      open.durationMs = durationMs;
      await open.save();
    } catch (err) {
      logger.warn(
        '[ExchangeConnectionLog] recordReconnect failed',
        formatError(err, { exchangeInstanceId })
      );
    }
  }

  /** 按交易所统计断连（错误）次数，返回 { exchangeInstanceId: count }。 */
  public async getErrorCounts(): Promise<Record<string, number>> {
    try {
      const rows = (await ExchangeConnectionLog.findAll({
        attributes: [
          'exchangeInstanceId',
          [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
        ],
        where: { eventType: 'disconnect' },
        group: ['exchangeInstanceId'],
        raw: true,
      })) as unknown as Array<{ exchangeInstanceId: string; cnt: number }>;

      const map: Record<string, number> = {};
      for (const r of rows) {
        map[r.exchangeInstanceId] = Number(r.cnt) || 0;
      }
      return map;
    } catch (err) {
      logger.warn('[ExchangeConnectionLog] getErrorCounts failed', formatError(err));
      return {};
    }
  }

  /**
   * 清空断连（错误）历史记录。
   * @param exchangeInstanceId 传入则只清空该交易所，缺省清空全部。
   * @returns 实际删除的记录条数
   */
  public async clearLogs(exchangeInstanceId?: string): Promise<number> {
    try {
      const where = exchangeInstanceId ? { exchangeInstanceId } : {};
      return await ExchangeConnectionLog.destroy({ where });
    } catch (err) {
      logger.warn('[ExchangeConnectionLog] clearLogs failed', formatError(err, { exchangeInstanceId }));
      return 0;
    }
  }

  /** 查询某交易所最近的断连历史记录（含仍处于断线中的记录）。 */
  public async getRecentLogs(
    exchangeInstanceId: string,
    limit: number = 20
  ): Promise<ExchangeConnectionLog[]> {
    try {
      const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
      return await ExchangeConnectionLog.findAll({
        where: { exchangeInstanceId },
        order: [['disconnectedAt', 'DESC']],
        limit: safeLimit,
      });
    } catch (err) {
      logger.warn(
        '[ExchangeConnectionLog] getRecentLogs failed',
        formatError(err, { exchangeInstanceId })
      );
      return [];
    }
  }
}

export default new ExchangeConnectionLogService();
