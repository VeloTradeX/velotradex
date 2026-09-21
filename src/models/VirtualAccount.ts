import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class VirtualAccount extends Model {
  public id!: number;
  public exchangeInstanceId!: string;
  public currency!: string;
  public initialBalance!: string;
  public availableBalance!: string;
  public realizedPnl!: string;
  public status!: 'active' | 'inactive';
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

VirtualAccount.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    exchangeInstanceId: { type: DataTypes.STRING, allowNull: false },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USDT' },
    initialBalance: { type: DataTypes.STRING, allowNull: false, defaultValue: '10000' },
    availableBalance: { type: DataTypes.STRING, allowNull: false, defaultValue: '10000' },
    realizedPnl: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
  },
  {
    sequelize,
    tableName: 'virtual_accounts',
    indexes: [
      {
        name: 'virtual_account_instance_currency',
        unique: true,
        fields: ['exchangeInstanceId', 'currency'],
      },
    ],
  },
);

export default VirtualAccount;
