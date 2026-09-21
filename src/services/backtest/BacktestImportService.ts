/**
 * 回测结果导入服务（仅主进程使用）。
 *
 * 回测子进程结束后会把隔离库中的全部业务数据导出为 result.json
 * （Strategy/Order/Virtual 各表/AuditLog/AILog/StrategyPosition/SoftStopLoss），
 * 本服务负责把它们导入主库，供既有页面（策略/订单/统计/虚拟交易所）查看：
 * - Strategy/Order 打上 backtestRunId，默认查询自动排除，与实盘数据互不干扰；
 * - 子库 id 与主库自增 id 不同：导入时重新分配 id 并重写所有外键引用
 *   （strategyId/orderId/positionId），保留 createdAt/updatedAt/closedAt 等
 *   「原始信号时间 / K 线触发时间」语义的时间戳；
 * - Virtual* 表按 exchangeInstanceId(=runKey) 归属回测虚拟交易所实例，
 *   virtualOrderId/tradeId 含随机后缀，导入不会与实盘虚拟订单冲突；
 * - 导入前先清理该 run 的旧数据，保证重复导入（停止后重导等）幂等。
 */
import fs from 'fs';
import { sequelize, Strategy, Order, ExchangeInstance, VirtualAccount, VirtualOrder, VirtualPosition, VirtualTrade, AuditLog, AILog, StrategyPosition, SoftStopLoss } from '../../models';
import logger, { formatError } from '../../utils/logger';

export interface BacktestRunResult {
  runKey: string;
  runId: number;
  stopped: boolean;
  finishedAt: string;
  simStartTime: string;
  simEndTime: string;
  initialBalance: number;
  summary: any;
  strategies: any[];
  orders: any[];
  virtualOrders: any[];
  virtualTrades: any[];
  virtualPositions: any[];
  virtualAccounts: any[];
  auditLogs?: any[];
  aiLogs?: any[];
  strategyPositions?: any[];
  softStopLosses?: any[];
}

class BacktestImportService {
  /** 读取并导入结果文件；返回 (result, summary) */
  public async importFromFile(resultPath: string, runId: number, runKey: string): Promise<{ result: BacktestRunResult; summary: any }> {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`回测结果文件不存在: ${resultPath}`);
    }
    const result: BacktestRunResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const summary = await this.importResult(result, runId, runKey);
    return { result, summary };
  }

  /** 将结果 JSON 导入主库（事务内；重复调用幂等） */
  public async importResult(result: BacktestRunResult, runId: number, runKey: string): Promise<any> {
    await sequelize.transaction(async (t: any) => {
      // 0. 清理旧数据（重导幂等）
      await this.deleteRunData(runId, runKey, t);

      // 1. Strategy：分配新 id，建立 子库id → 主库id 映射
      const strategyIdMap = new Map<number, number>();
      for (const row of result.strategies || []) {
        const { id, ...rest } = row;
        const created = await Strategy.create(
          { ...rest, backtestRunId: runId },
          { transaction: t },
        );
        strategyIdMap.set(id, created.id);
      }

      // 2. Order：重挂 strategyId
      const orderIdMap = new Map<number, number>();
      for (const row of result.orders || []) {
        const { id, strategyId, ...rest } = row;
        const created = await Order.create(
          {
            ...rest,
            strategyId: strategyId != null && strategyIdMap.has(strategyId) ? strategyIdMap.get(strategyId)! : null,
            backtestRunId: runId,
          },
          { transaction: t },
        );
        orderIdMap.set(id, created.id);
      }

      // 3. StrategyPosition：重挂 strategyId/orderId
      const positionIdMap = new Map<number, number>();
      for (const row of result.strategyPositions || []) {
        const { id, strategyId, orderId, ...rest } = row;
        const created = await StrategyPosition.create(
          {
            ...rest,
            strategyId: strategyId != null && strategyIdMap.has(strategyId) ? strategyIdMap.get(strategyId)! : null,
            orderId: orderId != null && orderIdMap.has(orderId) ? orderIdMap.get(orderId)! : null,
          },
          { transaction: t },
        );
        positionIdMap.set(id, created.id);
      }

      // 4. SoftStopLoss：重挂 strategyId/orderId/positionId
      for (const row of result.softStopLosses || []) {
        const { id, strategyId, orderId, positionId, ...rest } = row;
        await SoftStopLoss.create(
          {
            ...rest,
            strategyId: strategyId != null && strategyIdMap.has(strategyId) ? strategyIdMap.get(strategyId)! : null,
            orderId: orderId != null && orderIdMap.has(orderId) ? orderIdMap.get(orderId)! : null,
            positionId: positionId != null && positionIdMap.has(positionId) ? positionIdMap.get(positionId)! : null,
          },
          { transaction: t },
        );
      }

      // 5. AuditLog / AILog：重挂引用
      for (const row of result.auditLogs || []) {
        const { id, strategyId, orderId, ...rest } = row;
        await AuditLog.create(
          {
            ...rest,
            strategyId: strategyId != null && strategyIdMap.has(strategyId) ? strategyIdMap.get(strategyId)! : 0,
            orderId: orderId != null && orderIdMap.has(orderId) ? orderIdMap.get(orderId)! : null,
          },
          { transaction: t },
        );
      }
      for (const row of result.aiLogs || []) {
        const { id, strategyId, ...rest } = row;
        await AILog.create(
          {
            ...rest,
            strategyId: strategyId != null && strategyIdMap.has(strategyId) ? strategyIdMap.get(strategyId)! : null,
          },
          { transaction: t },
        );
      }

      // 6. Virtual*：直接按 runKey 归属导入（唯一键含随机后缀，无冲突）
      if ((result.virtualOrders || []).length > 0) {
        await VirtualOrder.bulkCreate(
          result.virtualOrders.map(({ id, ...rest }) => rest),
          { transaction: t },
        );
      }
      if ((result.virtualTrades || []).length > 0) {
        await VirtualTrade.bulkCreate(
          result.virtualTrades.map(({ id, ...rest }) => rest),
          { transaction: t },
        );
      }
      if ((result.virtualPositions || []).length > 0) {
        await VirtualPosition.bulkCreate(
          result.virtualPositions.map(({ id, ...rest }) => rest),
          { transaction: t },
        );
      }
      if ((result.virtualAccounts || []).length > 0) {
        await VirtualAccount.bulkCreate(
          result.virtualAccounts.map(({ id, ...rest }) => rest),
          { transaction: t },
        );
      }

      // 7. ExchangeInstance：登记回测虚拟交易所实例。
      //    status=inactive —— 主进程 ExchangeInstanceManager.initialize 只加载 active
      //    实例，因此不会在实盘进程内注册/启动 bt_ 撮合引擎（零干扰）；
      //    行本身保留，供虚拟交易所页面按实例 id 显式查询回测订单/成交。
      await ExchangeInstance.upsert(
        {
          id: runKey,
          type: 'virtual_gate_tradfi',
          name: `回测虚拟交易所 ${runKey}`,
          config: JSON.stringify({
            initialBalance: result.initialBalance,
            backtestRunId: runId,
            simStartTime: result.simStartTime,
            simEndTime: result.simEndTime,
          }),
          status: 'inactive',
        },
        { transaction: t },
      );
    });

    logger.info(`[BacktestImport] run=${runId} 导入完成: 策略 ${result.strategies.length} / 订单 ${result.orders.length} / 虚拟成交 ${(result.virtualTrades || []).length}`);
    return result.summary;
  }

  /** 删除某次回测在主库中的全部数据（导入前清理 / 删除回测时调用） */
  public async deleteRunData(runId: number, runKey: string, transaction?: any): Promise<void> {
    const t = transaction;
    const opts = t ? { transaction: t } : {};

    const strategies = await Strategy.findAll({ where: { backtestRunId: runId }, attributes: ['id'], ...opts } as any);
    const strategyIds = strategies.map((s: any) => s.id);
    const orders = await Order.findAll({ where: { backtestRunId: runId }, attributes: ['id'], ...opts } as any);
    const orderIds = orders.map((o: any) => o.id);

    // 审计/AI 日志按引用清理（这些表没有 backtestRunId 列）
    if (strategyIds.length > 0) {
      await AuditLog.destroy({ where: { strategyId: strategyIds }, ...opts });
      await AILog.destroy({ where: { strategyId: strategyIds }, ...opts });
      await SoftStopLoss.destroy({ where: { strategyId: strategyIds }, ...opts });
      await StrategyPosition.destroy({ where: { strategyId: strategyIds }, ...opts });
    }
    if (orderIds.length > 0) {
      await AuditLog.destroy({ where: { orderId: orderIds }, ...opts });
      await SoftStopLoss.destroy({ where: { orderId: orderIds }, ...opts });
      await StrategyPosition.destroy({ where: { orderId: orderIds }, ...opts });
    }

    await Order.destroy({ where: { backtestRunId: runId }, ...opts });
    await Strategy.destroy({ where: { backtestRunId: runId }, ...opts });

    // 虚拟交易所数据按实例 id（runKey）清理
    await VirtualOrder.destroy({ where: { exchangeInstanceId: runKey }, ...opts });
    await VirtualTrade.destroy({ where: { exchangeInstanceId: runKey }, ...opts });
    await VirtualPosition.destroy({ where: { exchangeInstanceId: runKey }, ...opts });
    await VirtualAccount.destroy({ where: { exchangeInstanceId: runKey }, ...opts });
  }
}

export default new BacktestImportService();
