import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class IdempotencyKey extends Model {
  public id!: number;
  public channelId!: string;
  public contentHash!: string;   // SHA256(content)
  public firstSeenAt!: Date;
  public messageId!: number | null;
  public strategyId!: number | null;
}

IdempotencyKey.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    channelId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    contentHash: {
      type: DataTypes.STRING(64), // SHA256 = 64 hex chars
      allowNull: false,
    },
    firstSeenAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    messageId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'idempotency_keys',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['channelId', 'contentHash'],
      },
      {
        fields: ['firstSeenAt'],
      },
    ],
  }
);

export default IdempotencyKey;
