import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class Strategy extends Model {
  public id!: number;
  public rawMessage!: string;
  public action!: string; // open, close, cancel
  public symbol!: string;
  public side!: string;
  public source!: string; // KOL source / channel_id
  public parserName!: string; // Parser name used
  public routes!: string; // JSON string of execution results
  public entryPrice!: string;
  public targets!: string; // JSON string
  public stopLoss!: string;
  public status!: string; // pending, processed, failed
  public aiAnalysis!: string | null;
  public signalOrigin!: string | null; // 'text' | 'image' | null
  public riskMultiplier!: number;
  public leverage!: string | null;
  public backtestRunId!: number | null; // 回测运行 id；实盘数据为 null
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Strategy.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    rawMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    action: {
      type: DataTypes.STRING,
      defaultValue: 'open',
      allowNull: true,
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    side: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    source: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    parserName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    entryPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    targets: {
      type: DataTypes.TEXT, // Store JSON as string for SQLite compatibility
      allowNull: true,
    },
    stopLoss: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'pending',
    },
    routes: {
      type: DataTypes.TEXT, // Store JSON of route execution results
      allowNull: true,
    },
    aiAnalysis: {
      type: DataTypes.TEXT, // Stores JSON result from AI
      allowNull: true,
    },
    signalOrigin: {
      type: DataTypes.STRING, // 信号来源：'text' = 纯文本，'image' = 图片视觉识别
      allowNull: true,
    },
    riskMultiplier: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 1.0,
    },
    leverage: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: '20',
    },
    backtestRunId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null, // null = 实盘数据
    },
  },
  {
    sequelize,
    tableName: 'strategies',
    indexes: [
      { fields: ['status'] },
      { fields: ['symbol'] },
      { fields: ['source'] },
      { fields: ['parserName'] },
      { fields: ['createdAt'] },
      { fields: ['backtestRunId'] },
    ],
  }
);

export default Strategy;
