import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class SoftStopLoss extends Model {
  public id!: number;
  public parserName!: string;
  public source!: string | null;
  public strategyId!: number | null;
  public orderId!: number | null;
  public positionId!: number | null;
  public exchangeInstanceId!: string | null;
  public symbol!: string;
  public side!: 'buy' | 'sell';
  public timeframe!: string;
  public direction!: 'close_under' | 'close_above';
  public price!: string;
  public sourceText!: string | null;
  public status!: 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'INVALID';
  public triggeredAt!: Date | null;
  public triggerClosePrice!: string | null;
  public raw!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

SoftStopLoss.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    parserName: { type: DataTypes.STRING, allowNull: false },
    source: { type: DataTypes.STRING, allowNull: true },
    strategyId: { type: DataTypes.INTEGER, allowNull: true },
    orderId: { type: DataTypes.INTEGER, allowNull: true },
    positionId: { type: DataTypes.INTEGER, allowNull: true },
    exchangeInstanceId: { type: DataTypes.STRING, allowNull: true },
    symbol: { type: DataTypes.STRING, allowNull: false },
    side: { type: DataTypes.STRING, allowNull: false },
    timeframe: { type: DataTypes.STRING, allowNull: false },
    direction: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.STRING, allowNull: false },
    sourceText: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'ACTIVE' },
    triggeredAt: { type: DataTypes.DATE, allowNull: true },
    triggerClosePrice: { type: DataTypes.STRING, allowNull: true },
    raw: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    sequelize,
    tableName: 'soft_stop_losses',
    indexes: [
      { fields: ['status', 'exchangeInstanceId'] },
      { fields: ['strategyId'] },
      { fields: ['orderId'] },
      { fields: ['symbol', 'side', 'status'] },
    ],
  }
);

export default SoftStopLoss;
