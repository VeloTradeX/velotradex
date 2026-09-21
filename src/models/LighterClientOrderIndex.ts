import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class LighterClientOrderIndex extends Model {
  public id!: number;
  public exchangeInstanceId!: string;
  public businessKey!: string;
  public clientOrderIndex!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

LighterClientOrderIndex.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    businessKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    clientOrderIndex: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'lighter_client_order_indexes',
    indexes: [
      {
        unique: true,
        fields: ['exchangeInstanceId', 'businessKey'],
      },
      {
        unique: true,
        fields: ['exchangeInstanceId', 'clientOrderIndex'],
      },
    ],
  },
);

export default LighterClientOrderIndex;
