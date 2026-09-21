import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class ParserConfig extends Model {
  public id!: number;
  public parserName!: string;
  public config!: string; // JSON string
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ParserConfig.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    parserName: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    config: {
      type: DataTypes.TEXT, // Store as JSON string
      allowNull: true,
      defaultValue: '{}'
    }
  },
  {
    sequelize,
    tableName: 'parser_configs',
  }
);

export default ParserConfig;
