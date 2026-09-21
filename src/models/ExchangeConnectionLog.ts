import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

/**
 * 交易所连接断开历史记录。
 *
 * 每次「连接断开 → 重连成功」记为一个断连事件（一行）：
 *  - 断开时写入 disconnectedAt / reason（此时 reconnectedAt / durationMs 为空，表示仍在断线中）；
 *  - 重连成功时回填 reconnectedAt 并计算 durationMs = reconnectedAt - disconnectedAt。
 *
 * durationMs 用于精确记录单次断连持续时间（需求方要求设计该字段并保证记录准确，
 * 即使暂不在界面上展示也保留）。
 */
class ExchangeConnectionLog extends Model {
  public id!: number;
  public exchangeInstanceId!: string;
  public exchangeName!: string | null;
  public exchangeType!: string | null;
  public eventType!: string; // 预留：'disconnect'（当前仅此一种）
  public reason!: string | null;
  public disconnectedAt!: Date;
  public reconnectedAt!: Date | null;
  public durationMs!: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ExchangeConnectionLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    exchangeName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    exchangeType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    eventType: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'disconnect',
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    disconnectedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    reconnectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '断连持续时间（毫秒），重连成功后回填',
    },
  },
  {
    sequelize,
    tableName: 'exchange_connection_logs',
    indexes: [
      { fields: ['exchangeInstanceId'] },
      { fields: ['disconnectedAt'] },
    ],
  }
);

export default ExchangeConnectionLog;
