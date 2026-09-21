import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { encryptSecret, decryptSecret, looksEncrypted, SENSITIVE_FIELDS } from '../utils/secretCipher';

class ExchangeInstance extends Model {
  public id!: string;
  public type!: string;
  public name!: string;
  public config!: string; // JSON string
  public status!: 'active' | 'inactive' | 'error';
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ExchangeInstance.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    config: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '{}',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'active',
    },
  },
  {
    sequelize,
    tableName: 'exchange_instances',
  }
);

/**
 * Field-level encryption at the storage boundary for secrets nested in
 * ExchangeInstance.config (a JSON string).
 *
 * - beforeSave / beforeBulkCreate: encrypt sensitive fields before persist.
 * - afterFind: decrypt sensitive fields in-memory after read.
 *
 * Idempotent: values already prefixed with `enc:v1:` are never re-encrypted,
 * and plaintext/legacy values pass through unchanged when no key is configured.
 */

function transformConfig(configStr: string, transform: (value: string) => string): string {
  if (!configStr) {
    return configStr;
  }
  let obj: any;
  try {
    obj = JSON.parse(configStr);
  } catch {
    return configStr;
  }
  if (typeof obj !== 'object' || obj === null) {
    return configStr;
  }
  for (const field of SENSITIVE_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string' && value.length > 0) {
      obj[field] = transform(value);
    }
  }
  return JSON.stringify(obj);
}

const encryptConfigField = (value: string): string =>
  looksEncrypted(value) ? value : encryptSecret(value);

const decryptConfigField = (value: string): string =>
  looksEncrypted(value) ? decryptSecret(value) : value;

function encryptInstanceConfig(instance: ExchangeInstance): void {
  if (typeof instance.config === 'string') {
    instance.config = transformConfig(instance.config, encryptConfigField);
  }
}

function decryptInstanceConfig(instance: ExchangeInstance): void {
  if (typeof instance.config === 'string') {
    instance.config = transformConfig(instance.config, decryptConfigField);
  }
}

ExchangeInstance.addHook('beforeSave', (instance: ExchangeInstance) => {
  encryptInstanceConfig(instance);
});

ExchangeInstance.addHook('beforeBulkCreate', (instances: ExchangeInstance[]) => {
  (Array.isArray(instances) ? instances : [instances]).forEach(encryptInstanceConfig);
});

ExchangeInstance.addHook('afterFind', (instancesOrInstance: ExchangeInstance | ExchangeInstance[] | null) => {
  if (Array.isArray(instancesOrInstance)) {
    instancesOrInstance.forEach(decryptInstanceConfig);
  } else if (instancesOrInstance) {
    decryptInstanceConfig(instancesOrInstance);
  }
});

export default ExchangeInstance;
