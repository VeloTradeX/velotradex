import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class VirtualOrder extends Model {
  public id!: number;
  public virtualOrderId!: string;
  public exchangeInstanceId!: string;
  public symbol!: string;
  public side!: 'buy' | 'sell';
  public type!: 'market' | 'limit';
  public orderRole!: 'entry' | 'tp' | 'sl' | 'close';
  public price!: string | null;
  public amount!: string;
  public filledAmount!: string | null;
  public filledPrice!: string | null;
  public status!: 'open' | 'filled' | 'cancelled' | 'rejected';
  public reduceOnly!: boolean;
  public postOnly!: boolean;
  public triggerPrice!: string | null;
  public triggerCondition!: 'ge' | 'le' | null;
  public text!: string | null;
  public parentSide!: 'buy' | 'sell' | null;
  public parentOrderId!: string | null;
  public raw!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

VirtualOrder.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    virtualOrderId: { type: DataTypes.STRING, allowNull: false, unique: true },
    exchangeInstanceId: { type: DataTypes.STRING, allowNull: false },
    symbol: { type: DataTypes.STRING, allowNull: false },
    side: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    orderRole: { type: DataTypes.STRING, allowNull: false, defaultValue: 'entry' },
    price: { type: DataTypes.STRING, allowNull: true },
    amount: { type: DataTypes.STRING, allowNull: false },
    filledAmount: { type: DataTypes.STRING, allowNull: true },
    filledPrice: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'open' },
    reduceOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    postOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    triggerPrice: { type: DataTypes.STRING, allowNull: true },
    triggerCondition: { type: DataTypes.STRING, allowNull: true },
    text: { type: DataTypes.STRING, allowNull: true },
    parentSide: { type: DataTypes.STRING, allowNull: true },
    parentOrderId: { type: DataTypes.STRING, allowNull: true },
    raw: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'virtual_orders' },
);

export default VirtualOrder;
