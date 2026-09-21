import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

const LIGHTER_TX_JOURNAL_STATUSES = [
  'CREATED',
  'SIGNED',
  'SENT',
  'ACCEPTED',
  'CONFIRMED',
  'REJECTED',
  'UNKNOWN',
] as const;

export type LighterTxJournalStatus =
  typeof LIGHTER_TX_JOURNAL_STATUSES[number];

class LighterTxJournal extends Model {
  public txId!: string;
  public exchangeInstanceId!: string;
  public accountIndex!: number;
  public apiKeyIndex!: number;
  public nonce!: string;
  public txType!: number;
  public txInfoHash!: string;
  public intentJson!: string;
  public status!: LighterTxJournalStatus;
  public strategyId!: number | null;
  public orderId!: number | null;
  public clientOrderIndex!: string | null;
  public error!: string | null;
  public confirmedAt!: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

LighterTxJournal.init(
  {
    txId: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    accountIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    apiKeyIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    nonce: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    txType: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    txInfoHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    intentJson: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'CREATED',
      validate: {
        isIn: [LIGHTER_TX_JOURNAL_STATUSES],
      },
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    clientOrderIndex: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    confirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'lighter_tx_journals',
    indexes: [
      {
        fields: ['exchangeInstanceId', 'status'],
      },
      {
        fields: ['exchangeInstanceId', 'accountIndex', 'apiKeyIndex', 'nonce'],
      },
      {
        fields: ['clientOrderIndex'],
      },
    ],
  },
);

export default LighterTxJournal;
