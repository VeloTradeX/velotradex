import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class VirtualTrade extends Model {
  public id!: number;
  public tradeId!: string;
  public virtualOrderId!: string;
  public exchangeInstanceId!: string;
  public symbol!: string;
  public side!: 'buy' | 'sell';
  public price!: string;
  public amount!: string;
  public role!: 'maker' | 'taker';
  public realizedPnl!: string;
  public text!: string | null;
  public executedAt!: Date;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

VirtualTrade.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tradeId: { type: DataTypes.STRING, allowNull: false, unique: true },
    virtualOrderId: { type: DataTypes.STRING, allowNull: false },
    exchangeInstanceId: { type: DataTypes.STRING, allowNull: false },
    symbol: { type: DataTypes.STRING, allowNull: false },
    side: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.STRING, allowNull: false },
    amount: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: false, defaultValue: 'taker' },
    realizedPnl: { type: DataTypes.STRING, allowNull: false, defaultValue: '0' },
    text: { type: DataTypes.STRING, allowNull: true },
    executedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'virtual_trades' },
);

export default VirtualTrade;
