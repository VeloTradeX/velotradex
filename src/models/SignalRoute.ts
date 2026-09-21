import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class SignalRoute extends Model {
  public id!: number;
  public name!: string;
  public channelId!: string;
  public exchangeInstanceId!: string;
  public parser!: string;
  public riskSettings!: string; // JSON string
  public symbolSpecificSettings!: string; // JSON string: { [symbol: string]: { riskValue: number } }
  public supportedSymbols!: string; // JSON string
  public isActive!: boolean;
  public aiMode!: string; // disabled, analyze_only, enabled
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

SignalRoute.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    channelId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    parser: {
      type: DataTypes.STRING,
      allowNull: true, // Allow null for migration, but should be required eventually
      defaultValue: 'DefaultParser' // Default to a known parser or handle null
    },
    riskSettings: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '{}',
    },
    symbolSpecificSettings: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '{}',
    },
    supportedSymbols: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null, // null means allow all
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    aiMode: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'disabled', // disabled, analyze_only, enabled
    },
  },
  {
    sequelize,
    tableName: 'signal_routes',
    indexes: [
      { fields: ['channelId'] },
      { fields: ['exchangeInstanceId'] },
      { fields: ['isActive'] },
    ],
  }
);

export default SignalRoute;
