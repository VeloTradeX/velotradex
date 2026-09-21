import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class StrategyPosition extends Model {
  public id!: number;
  public strategyId!: number | null;
  public orderId!: number | null;
  public routeId!: number | null;
  public exchangeInstanceId!: string | null;
  public symbol!: string;
  public side!: 'buy' | 'sell';
  public totalSize!: string;
  public remainingSize!: string;
  public source!: string | null;
  public parserName!: string | null;
  public status!: 'OPEN' | 'PARTIAL' | 'CLOSED';
  public closedAt!: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

StrategyPosition.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: true
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: false
    },
    side: {
      type: DataTypes.STRING,
      allowNull: false
    },
    totalSize: {
      type: DataTypes.STRING,
      allowNull: false
    },
    remainingSize: {
      type: DataTypes.STRING,
      allowNull: false
    },
    source: {
      type: DataTypes.STRING,
      allowNull: true
    },
    parserName: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'OPEN'
    },
    closedAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    sequelize,
    tableName: 'strategy_positions',
    indexes: [
      { fields: ['strategyId'] },
      { fields: ['orderId'] },
      { fields: ['exchangeInstanceId', 'symbol', 'status'] },
    ],
  }
);

export default StrategyPosition;
