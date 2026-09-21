import { sequelize } from '../db';
import Strategy from './Strategy';
import Order from './Order';
import User from './User';
import ExchangeInstance from './ExchangeInstance';
import SignalRoute from './SignalRoute';
import PendingProtection from './PendingProtection';
import AuditLog from './AuditLog';
import ApiAuditLog from './ApiAuditLog';
import WebhookConfig from './WebhookConfig';
import AIConfig from './AIConfig';
import AILog from './AILog';
import StrategyPosition from './StrategyPosition';
import ImageDownloadCache from './ImageDownloadCache';
import IdempotencyKey from './IdempotencyKey';
import SoftStopLoss from './SoftStopLoss';
import MarketDataSource from './MarketDataSource';
import VirtualAccount from './VirtualAccount';
import VirtualPosition from './VirtualPosition';
import VirtualOrder from './VirtualOrder';
import VirtualTrade from './VirtualTrade';
import LighterTxJournal from './LighterTxJournal';
import LighterClientOrderIndex from './LighterClientOrderIndex';
import ApiCredential from './ApiCredential';
import CfdLegGroup from './CfdLegGroup';
import CfdLeg from './CfdLeg';
import ExchangeConnectionLog from './ExchangeConnectionLog';
import BacktestRun from './BacktestRun';

// Define associations
Strategy.hasMany(Order, { foreignKey: 'strategyId', as: 'Orders' });
Order.belongsTo(Strategy, { foreignKey: 'strategyId', as: 'Strategy' });
Strategy.hasMany(StrategyPosition, { foreignKey: 'strategyId' });
StrategyPosition.belongsTo(Strategy, { foreignKey: 'strategyId' });
Order.hasMany(StrategyPosition, { foreignKey: 'orderId' });
StrategyPosition.belongsTo(Order, { foreignKey: 'orderId' });
Strategy.hasMany(SoftStopLoss, { foreignKey: 'strategyId' });
SoftStopLoss.belongsTo(Strategy, { foreignKey: 'strategyId' });
Strategy.hasMany(AuditLog, { foreignKey: 'strategyId', as: 'AuditLogs' });
AuditLog.belongsTo(Strategy, { foreignKey: 'strategyId', as: 'Strategy' });
Order.hasMany(SoftStopLoss, { foreignKey: 'orderId' });
SoftStopLoss.belongsTo(Order, { foreignKey: 'orderId' });
StrategyPosition.hasMany(SoftStopLoss, { foreignKey: 'positionId' });
SoftStopLoss.belongsTo(StrategyPosition, { foreignKey: 'positionId' });

// CFD 多腿分组/腿明细关联（Order 表零改动，通过 orderId 关联）
CfdLegGroup.hasMany(CfdLeg, { foreignKey: 'legGroupId', as: 'legs' });
CfdLeg.belongsTo(CfdLegGroup, { foreignKey: 'legGroupId', as: 'group' });
Order.hasOne(CfdLeg, { foreignKey: 'orderId', as: 'cfdLeg' });
CfdLeg.belongsTo(Order, { foreignKey: 'orderId', as: 'order' });

export {
  sequelize,
  Strategy,
  Order,
  User,
  ExchangeInstance,
  SignalRoute,
  PendingProtection,
  AuditLog,
  ApiAuditLog,
  WebhookConfig,
  AIConfig,
  AILog,
  StrategyPosition,
  ImageDownloadCache,
  IdempotencyKey,
  SoftStopLoss,
  MarketDataSource,
  VirtualAccount,
  VirtualPosition,
  VirtualOrder,
  VirtualTrade,
  LighterTxJournal,
  LighterClientOrderIndex,
  ApiCredential,
  CfdLegGroup,
  CfdLeg,
  ExchangeConnectionLog,
  BacktestRun,
};

export default sequelize;
