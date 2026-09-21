import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class Order extends Model {
  public id!: number;
  public strategyId!: number;
  public routeId!: number | null;
  public exchangeOrderId!: string;
  public exchangeInstanceId!: string;
  public source!: string; // KOL source / channel_id
  public exchange!: string; // Execution exchange
  public symbol!: string;
  public side!: string;
  public amount!: string;
  public price!: string;
  public filledAmount!: string;
  public filledPrice!: string;
  public status!: string;
  public lifecycleStatus!: 'INIT' | 'PENDING' | 'OPEN' | 'PROTECTED' | 'CLOSED' | 'FAILED' | 'RISK_UNPROTECTED';
  public relatedMessages!: string; // JSON array of strategy IDs
  public initialSl!: string;
  public initialTp!: string;
  public currentSl!: string;
  public currentTp!: string;
  public type!: 'limit' | 'market';
  public leverage!: string;
  public isSimulated!: boolean;
  public realizedPnl!: string;
  public fees!: string;
  public mathMultiplier!: string;
  public exitPrice!: string;
  public closedAt!: Date;
  public response!: string; // Store full response
  public activeStopLossId!: string | null;
  public activeTpIds!: string | null;
  public closePrice!: string | null;
  public lastPrice!: string | null;
  // Virtual (non-persisted) P&L fields set by listVirtualBusinessOrders
  public pnlAmount!: string | null;
  public pnlPercent!: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  public getActiveTpIds(): string[] {
    if (!this.activeTpIds) return [];
    try {
      return JSON.parse(this.activeTpIds) as string[];
    } catch {
      return [];
    }
  }
}

Order.init(
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
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    exchangeOrderId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    source: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    exchange: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    side: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    amount: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    price: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    filledAmount: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    filledPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'new',
    },
    lifecycleStatus: {
      type: DataTypes.STRING,
      defaultValue: 'INIT',
    },
    relatedMessages: {
      type: DataTypes.TEXT, // JSON array
      defaultValue: '[]',
    },
    initialSl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    initialTp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    currentSl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    currentTp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    leverage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isSimulated: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    realizedPnl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    fees: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    mathMultiplier: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    exitPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    closedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    response: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    activeStopLossId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    activeTpIds: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    closePrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lastPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    backtestRunId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null, // null = 实盘数据
    },
  },
  {
    sequelize,
    tableName: 'orders',
    indexes: [
      { fields: ['strategyId'] },
      { fields: ['exchangeInstanceId', 'lifecycleStatus'] },
      { fields: ['lifecycleStatus', 'closedAt'] },
      { fields: ['symbol', 'status'] },
      { fields: ['isSimulated'] },
      { fields: ['backtestRunId'] },
    ],
  }
);

export default Order;
