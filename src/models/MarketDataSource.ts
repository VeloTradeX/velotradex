import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class MarketDataSource extends Model {
  public id!: string;
  public type!: 'gate';
  public name!: string;
  public config!: string;
  public status!: 'active' | 'inactive' | 'error';
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

MarketDataSource.init(
  {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'gate' },
    name: { type: DataTypes.STRING, allowNull: false },
    config: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
  },
  { sequelize, tableName: 'market_data_sources' },
);

export default MarketDataSource;
