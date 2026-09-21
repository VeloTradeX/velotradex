import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

/**
 * 回测运行记录（仅主进程使用）。
 *
 * 一次回测 = 一行记录 + 一个隔离的回测子进程：
 * - status: pending(已创建) / preparing(拉K线建环境) / running(重放中)
 *           / completed(完成且结果已导入) / stopped(手动停止) / failed(失败)
 * - progress: JSON { phase, candlesDone, candlesTotal, simTime, messagesProcessed, messagesTotal }
 * - summary: JSON 完成后的汇总统计（订单数/胜率/PnL/权益曲线等）
 * - config: JSON 运行配置快照（routeId、initialBalance、aiEnabled 等）
 * - 子进程内的 Strategy/Order/Virtual* 数据在完成后导入主库，
 *   以 backtestRunId / exchangeInstanceId(bt_{runKey}) 关联。
 */
class BacktestRun extends Model {
  public id!: number;
  public runKey!: string; // 如 bt_20260901120000_xxxx，用作虚拟交易所实例 id
  public name!: string;
  public status!: string;
  public messagesPath!: string; // 规范化消息文件（服务端路径）
  public messageCount!: number;
  public rangeStart!: Date | null; // 消息时间范围（=回测时间范围）
  public rangeEnd!: Date | null;
  public parserName!: string | null;
  public routeId!: number | null; // 克隆的原始路由 id
  public config!: string; // JSON
  public progress!: string; // JSON
  public summary!: string; // JSON
  public error!: string | null;
  public childPid!: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

BacktestRun.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    runKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending',
    },
    messagesPath: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    messageCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    rangeStart: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rangeEnd: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    parserName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    config: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    progress: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    childPid: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'backtest_runs',
    indexes: [
      { fields: ['status'] },
      { fields: ['runKey'], unique: true },
    ],
  }
);

export default BacktestRun;
