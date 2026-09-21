import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Environment loading logic
const appEnv = process.env.APP_ENV || 'development';
const envFile = `.env.${appEnv}`;
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
  console.log(`Loading environment from ${envFile}`);
  dotenv.config({ path: envPath });
} else {
  if (appEnv !== 'development') {
    console.warn(`Warning: Configuration file ${envFile} not found.`);
  }
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

console.log(`Current Environment: ${appEnv}`);

/**
 * Automatically override config values from process.env
 * Converts camelCase keys to SNAKE_CASE (e.g., msgChannel -> MSG_CHANNEL)
 * Joins nested keys with underscore (e.g., redis.host -> REDIS_HOST)
 */
function loadFromEnv(config: any, prefix: string = '') {
  for (const key in config) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      const value = config[key];
      // Convert camelCase to SNAKE_CASE
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
      const envKey = prefix ? `${prefix}_${snakeKey}` : snakeKey;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        loadFromEnv(value, envKey);
      } else {
        const envVal = process.env[envKey];
        if (envVal !== undefined) {
          if (typeof value === 'number') {
            config[key] = Number(envVal);
          } else if (typeof value === 'boolean') {
            config[key] = envVal === 'true';
          } else {
            config[key] = envVal;
          }
        }
      }
    }
  }
}

// 1. Define Default Configuration
const config = {
  server: {
    port: 3000,
    jwtSecret: 'change_me_please_super_secret',
    jwtExpiresIn: '24h',
    // Refresh token 独立有效期（滑动续期：每次刷新后重新开始计时）。
    // 留空时回退为 access 有效期的 10 倍（旧行为）。
    jwtRefreshExpiresIn: '240h',
    // 会话绝对上限：即使一直活跃，超过该时长也强制重新登录（0/空 = 不限制）。
    jwtSessionMax: '30d',
    enableApiAudit: true,
    // Optional field-level AES-256-GCM encryption key for exchange/AI secrets.
    // Injected via SERVER_ENCRYPTION_KEY. When empty, secrets stay in plaintext
    // (backward compatible); when set, sensitive fields are encrypted at rest.
    encryptionKey: '',
  },
  redis: {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
    msgChannel: 'discord:msg'
  },
  backtest: {
    // 回测子进程标记：BACKTEST_CHILD=1 时禁用实盘 WS 行情源（改由回测引擎注入）、
    // 跳过默认交易所实例创建。主进程恒为 false。
    child: process.env.BACKTEST_CHILD === '1',
    // 子进程运行配置文件路径（BACKTEST_RUN_CONFIG）
    runConfig: process.env.BACKTEST_RUN_CONFIG || '',
  },
  db: {
    database: 'velotradex',
    dialect: 'sqlite',
    storage: './data/velotradex.db',
    logging: false
  },
  defaultPosition: {
    leverage: 10,
    marginType: 'cross' as 'cross' | 'isolated',
    positionMode: 'one-way' as 'one-way' | 'hedge'
  },
  external: {
    urls: {
      gateApiBase: 'https://api.gateio.ws/api/v4',
      lighterMainnet: 'https://mainnet.zklighter.elliot.ai',
      pushoverApi: 'https://api.pushover.net/1/messages.json',
    }
  },
  trading: {
    mode: 'observe', // real | testnet | observe
    exchange: 'gate' as 'gate',
    wsProxy: '',
    apiProxy: '',
    gate: {
      realApiKey: '',
      realApiSecret: '',
      testnetApiKey: '',
      testnetApiSecret: '',
      baseURL: {
        real: 'https://api.gateio.ws/api/v4',
        testnet: 'https://api-testnet.gateio.ws/api/v4'
      }
    },
    gate_tradfi: {
      apiKey: '',
      apiSecret: '',
      baseURL: 'https://api.gateio.ws/api/v4',
      wsURL: 'wss://fx-ws.gateio.ws/v4/ws/tradfi',
      proxyUrl: '',
    },
    execution: {
      defaultPaddingR: {
        entry: 0.01,
        tp: 0.01,
        sl: 0.01
      }
    }
  }
};

// 2. Override with Environment Variables
loadFromEnv(config);

// 2.0.1 回测子进程标记：loadFromEnv 的布尔解析只认 'true'，而子进程 spawn 习惯用 1，
// 这里在覆盖之后强制按环境变量重读，保证 BACKTEST_CHILD=1 / BACKTEST_CHILD=true 均生效。
config.backtest.child = process.env.BACKTEST_CHILD === '1' || process.env.BACKTEST_CHILD === 'true';
config.backtest.runConfig = process.env.BACKTEST_RUN_CONFIG || config.backtest.runConfig || '';

// 2.1 Apply generic proxy fallback for modules that need outbound networking.
const commonProxy =
  process.env.ALL_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  '';

if (commonProxy) {
  if (!config.trading.apiProxy) {
    config.trading.apiProxy = commonProxy;
  }
  if (!config.trading.wsProxy) {
    config.trading.wsProxy = commonProxy;
  }
}

// 2.2 Startup safety check: reject insecure default JWT secret
// 占位值必须同时覆盖 config.ts 内的默认值与 .env.example 里的示例值。
// 历史上两者不一致（此处曾只比对 'change_me_please_super_secret'），
// 导致按文档复制 .env.example 的用户实际带着弱密钥运行，本校验从未生效。
const INSECURE_JWT_SECRETS = new Set([
  '',
  'change_me_please_super_secret',
  'change_me_to_a_long_random_secret',
]);

if (INSECURE_JWT_SECRETS.has(config.server.jwtSecret)) {
  const generateHint =
    "SERVER_JWT_SECRET=$(node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\")";
  // 生产模式（docker-compose 默认 NODE_ENV=production）直接拒绝启动；
  // 开发/测试环境只告警，避免本地起不来或把单测进程干掉。
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️  FATAL: SERVER_JWT_SECRET is using the insecure default value.');
    console.error(`   Set SERVER_JWT_SECRET to a long random string before starting, e.g. ${generateHint}`);
    process.exit(1);
  } else if (process.env.NODE_ENV !== 'test') {
    console.warn('⚠️  WARNING: SERVER_JWT_SECRET is using the insecure default value.');
    console.warn(`   This is rejected in production (NODE_ENV=production). Generate one with: ${generateHint}`);
  }
}

// 3. Export with computed properties
export default {
  ...config,
  trading: {
    ...config.trading,
    gate: {
      ...config.trading.gate,
      // Dynamic getter for active API Key based on mode
      get apiKey(): string {
        return config.trading.mode === 'testnet' 
          ? config.trading.gate.testnetApiKey 
          : config.trading.gate.realApiKey;
      },
      get apiSecret(): string {
        return config.trading.mode === 'testnet'
          ? config.trading.gate.testnetApiSecret
          : config.trading.gate.realApiSecret;
      }
    },
  },
  get enableTrading(): boolean {
    return config.trading.mode === 'real' || config.trading.mode === 'testnet';
  }
};
