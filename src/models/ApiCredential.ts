import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class ApiCredential extends Model {
  public id!: number;
  public name!: string;
  public tokenPrefix!: string;
  public tokenHash!: string;
  public scopes!: string;
  public expiresAt!: Date | null;
  public lastUsedAt!: Date | null;
  public disabledAt!: Date | null;
  public createdByUserId!: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ApiCredential.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tokenPrefix: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    tokenHash: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    scopes: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    disabledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'api_credentials',
  }
);

export default ApiCredential;
