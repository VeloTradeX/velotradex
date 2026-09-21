import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class AuditLog extends Model {
  public id!: number;
  public strategyId!: number;
  public orderId!: number | null;
  public action!: string;
  public exchangeInstanceId!: string | null;
  public routeId!: number | null;
  public lifecycleStatus!: string; // Snapshot of order status
  public details!: string; // JSON string
  public readonly createdAt!: Date;
}

AuditLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lifecycleStatus: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    details: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'audit_logs',
    updatedAt: false,
    indexes: [
      { fields: ['createdAt'] },
      { fields: ['strategyId'] },
      { fields: ['orderId'] },
    ],
  }
);

export default AuditLog;
