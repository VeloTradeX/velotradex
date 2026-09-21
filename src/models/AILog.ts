import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class AILog extends Model {
  public id!: number;
  public strategyId!: number | null;
  public routeIds?: string | null;
  public routeNames?: string | null;
  public model!: string;
  public originalMessage?: string;
  public systemPrompt?: string;
  public prompt!: string;
  public response!: string;
  public promptTokens!: number;
  public completionTokens!: number;
  public totalTokens!: number;
  public durationMs!: number;
  public status!: 'success' | 'error';
  public error?: string;
  public imageBase64?: string;
  public readonly createdAt!: Date;
}

AILog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    routeIds: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    routeNames: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    model: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    originalMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    systemPrompt: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    response: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    promptTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    completionTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'success',
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    imageBase64: {
      type: DataTypes.TEXT,
      allowNull: true,
    }
  },
  {
    sequelize,
    tableName: 'ai_logs',
    indexes: [
      { fields: ['createdAt'] },
      { fields: ['strategyId'] },
    ],
  }
);

export default AILog;
