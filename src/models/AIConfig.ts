import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { encryptSecret, decryptSecret, looksEncrypted } from '../utils/secretCipher';

class AIConfig extends Model {
  public id!: number;
  public provider!: string; // 'openai', 'gemini', 'anthropic', etc.
  public apiKey!: string;
  public baseUrl!: string | null; // Custom Base URL for OpenAI compatible providers
  public textModel!: string; // 'gpt-4o', 'gemini-pro', etc.
  public visionModel!: string; // 'gpt-4o', 'glm-4v', etc.
  public stripChinese!: boolean;
  public extraPayload!: string | null;
  public requestTimeoutMs!: number;
  public promptTemplate!: string;
  public mode!: string; // 'enabled', 'analyze_only', 'disabled'
  public contextMessageCount!: number; // How many recent messages to include
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AIConfig.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'openai',
    },
    apiKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    baseUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    textModel: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'gpt-4o',
    },
    visionModel: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'gpt-4o',
    },
    stripChinese: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    extraPayload: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    requestTimeoutMs: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 60000,
    },
    promptTemplate: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: `<system>
You are an expert crypto trading signal parser. Analyze the message and output JSON only.
</system>

<market>
  <current_price>{{currentPrice}}</current_price>
</market>

{{positions}}

{{context}}

<current_message>
  <text>{{message}}</text>
</current_message>

<output_format>
{
  "action": "open|close|update|cancel|ignore",
  "symbol": "BTC_USDT",
  "side": "buy|sell (required when action=open)",
  "entryPrice": "number (required when action=open)",
  "targets": [number],
  "stopLoss": "number (required when action=open)",
  "leverage": number,
  "confidence": "number (0-1)",
  "reasoning": "string"
}
</output_format>`,
    },
    mode: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'disabled', // enabled, analyze_only, disabled
    },
    contextMessageCount: {
      type: DataTypes.INTEGER,
      defaultValue: 5,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    sequelize,
    tableName: 'ai_configs',
  }
);

/**
 * Field-level encryption at the storage boundary for AIConfig.apiKey.
 * - beforeSave: encrypt apiKey before persist (idempotent, skips `enc:v1:` values).
 * - afterFind: decrypt apiKey in-memory after read.
 * Backward compatible: plaintext passthrough when no encryption key is configured.
 */

AIConfig.addHook('beforeSave', (instance: AIConfig) => {
  if (
    typeof instance.apiKey === 'string' &&
    instance.apiKey.length > 0 &&
    !looksEncrypted(instance.apiKey)
  ) {
    instance.apiKey = encryptSecret(instance.apiKey);
  }
});

AIConfig.addHook('afterFind', (instancesOrInstance: AIConfig | AIConfig[] | null) => {
  const decryptOne = (instance: AIConfig): void => {
    if (typeof instance.apiKey === 'string' && looksEncrypted(instance.apiKey)) {
      instance.apiKey = decryptSecret(instance.apiKey);
    }
  };
  if (Array.isArray(instancesOrInstance)) {
    instancesOrInstance.forEach(decryptOne);
  } else if (instancesOrInstance) {
    decryptOne(instancesOrInstance);
  }
});

export default AIConfig;
