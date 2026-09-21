import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class ApiAuditLog extends Model {
  public id!: number;
  public userId!: number;
  public username!: string;
  public method!: string;
  public path!: string;
  public params!: string; // JSON string of query or body
  public statusCode!: number;
  public ip!: string;
  public duration!: number; // ms
  public readonly createdAt!: Date;
}

ApiAuditLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    username: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    method: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    path: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    params: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    statusCode: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ip: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'api_audit_logs',
    updatedAt: false, // Only need createdAt
    indexes: [
      { fields: ['createdAt'] },
      { fields: ['userId'] },
      { fields: ['method'] },
    ],
  }
);

export default ApiAuditLog;
