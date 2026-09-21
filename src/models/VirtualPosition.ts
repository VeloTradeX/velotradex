import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class VirtualPosition extends Model {
  public id!: number;
  public exchangeInstanceId!: string;
  public symbol!: string;
  public size!: string;
  public entryPrice!: string;
  public markPrice!: string;
  public realizedPnl!: string;
  public leverage!: string;
  public marginType!: 'cross' | 'isolated';
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

VirtualPosition.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    exchangeInstanceId: { type: DataTypes.STRING, allowNull: false },
    symbol: { type: DataTypes.STRING, allowNull: false },
    size: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    entryPrice: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    markPrice: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    realizedPnl: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    leverage: { type: DataTypes.STRING, allowNull: false, defaultValue: '1' },
    marginType: { type: DataTypes.STRING, allowNull: false, defaultValue: 'cross' },
  },
  {
    sequelize,
    tableName: 'virtual_positions',
    indexes: [
      {
        name: 'virtual_position_instance_symbol',
        unique: true,
        fields: ['exchangeInstanceId', 'symbol'],
      },
    ],
  },
);

export default VirtualPosition;
