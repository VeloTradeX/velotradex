import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

class WebhookConfig extends Model {
  public id!: number;
  public name!: string;
  public type!: string;
  public url!: string;
  public method!: string;
  public headers!: string; // JSON string
  public template!: string; // Custom body template
  public config!: string; // JSON string for extra config
  public events!: string; // JSON string array of event types
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

WebhookConfig.init(
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
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'webhook', // webhook, feishu, dingtalk, pushover
    },
    url: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // For generic webhook
    method: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'POST',
    },
    headers: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '{}',
      get() {
        const rawValue = this.getDataValue('headers');
        try {
          return rawValue ? JSON.parse(rawValue) : {};
        } catch (e) {
          return {};
        }
      },
      set(value: any) {
        if (typeof value === 'string') {
            this.setDataValue('headers', value);
        } else {
            this.setDataValue('headers', JSON.stringify(value));
        }
      }
    },
    template: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // For specific integrations (e.g. pushover user/token)
    config: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '{}',
      get() {
        const rawValue = this.getDataValue('config');
        try {
          return rawValue ? JSON.parse(rawValue) : {};
        } catch (e) {
          return {};
        }
      },
      set(value: any) {
        if (typeof value === 'string') {
            this.setDataValue('config', value);
        } else {
            this.setDataValue('config', JSON.stringify(value));
        }
      }
    },
    events: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
      get() {
        const rawValue = this.getDataValue('events');
        try {
          return rawValue ? JSON.parse(rawValue) : [];
        } catch (e) {
          return [];
        }
      },
      set(value: string[] | string) {
        if (typeof value === 'string') {
            this.setDataValue('events', value);
        } else {
            this.setDataValue('events', JSON.stringify(value));
        }
      }
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    sequelize,
    tableName: 'webhook_configs',
  }
);

export default WebhookConfig;
