
import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class PendingProtection extends Model {
  public orderId!: string;
  public symbol!: string;
  public side!: string;
  public stopLoss!: string | null;
  public takeProfit!: string | null;
  public tpOrdersJson!: string | null;
  public status!: 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'FAILED';
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

PendingProtection.init(
  {
    orderId: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    side: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    stopLoss: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    takeProfit: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    tpOrdersJson: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'PENDING',
      validate: {
        isIn: [['PENDING', 'CLAIMED', 'COMPLETED', 'FAILED']],
      },
    },
  },
  {
    sequelize,
    tableName: 'pending_protections',
    indexes: [
      { fields: ['status'] },
      { fields: ['symbol', 'side'] },
    ],
  }
);

export default PendingProtection;
