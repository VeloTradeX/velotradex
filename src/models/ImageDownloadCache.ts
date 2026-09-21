import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class ImageDownloadCache extends Model {
  public id!: number;
  public url!: string;
  public urlHash!: string;
  public imageBase64!: string;
  public mimeType!: string | null;
  public sizeBytes!: number | null;
  public hitCount!: number;
  public lastAccessedAt!: Date;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ImageDownloadCache.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    urlHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    imageBase64: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    sizeBytes: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    hitCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastAccessedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'image_download_caches',
  }
);

export default ImageDownloadCache;
