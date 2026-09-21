import appConfig from '../config';

export const sensitiveFields = ['apiSecret', 'secret', 'password', 'privateKey', 'apiPrivateKey'];

export const applyDefaultConfig = (type: string, config: any) => {
    if (type === 'gate') {
        // Normalize isTestnet to boolean
        if (typeof config.isTestnet === 'string') {
            config.isTestnet = config.isTestnet === 'true';
        }
        const isTestnet = !!config.isTestnet;

        if (!config.baseURL || config.baseURL.trim() === '') {
            config.baseURL = isTestnet
                ? 'https://api-testnet.gateio.ws/api/v4'
                : appConfig.external.urls.gateApiBase;
        }

        if (!config.wsURL || config.wsURL.trim() === '') {
            config.wsURL = isTestnet
                ? 'wss://ws-testnet.gate.com/v4/ws/futures/usdt'
                : 'wss://fx-ws.gateio.ws/v4/ws/usdt';
        }
    } else if (type === 'virtual_gate') {
        config.initialBalance = config.initialBalance || '10000';
        config.currency = config.currency || 'USDT';
        config.marketDataSourceId = config.marketDataSourceId || 'gate_public_main';
        config.supportedSymbols = Array.isArray(config.supportedSymbols) ? config.supportedSymbols : [];
        config.maxTickAgeMs = Number(config.maxTickAgeMs || 10000);
        config.autoRestore = config.autoRestore !== false;
    } else if (type === 'virtual_gate_tradfi') {
        // 虚拟 Gate TradFi：与虚拟 Gate 同构（虚拟撮合），区别仅在行情源取自 Gate TradFi
        config.initialBalance = config.initialBalance || '10000';
        config.currency = config.currency || 'USDT';
        config.supportedSymbols = Array.isArray(config.supportedSymbols) ? config.supportedSymbols : [];
        config.maxTickAgeMs = Number(config.maxTickAgeMs || 10000);
        config.autoRestore = config.autoRestore !== false;
    } else if (type === 'gate_tradfi' || type === 'gate_cfd') {
        // Gate-CFD（/tradfi/*）：无 WebSocket 通道，仅 REST，baseURL 缺省主网
        if (!config.baseURL || config.baseURL.trim() === '') {
            config.baseURL = 'https://api.gateio.ws/api/v4';
        }
    } else if (type === 'lighter') {
        if (!config.baseURL || config.baseURL.trim() === '') {
            config.baseURL = 'https://mainnet.zklighter.elliot.ai';
        }
        if (!config.wsURL || config.wsURL.trim() === '') {
            config.wsURL = 'wss://mainnet.zklighter.elliot.ai/stream';
        }
        config.balanceCurrency = config.balanceCurrency || 'USDC';
        config.defaultSlippageBps = Number(config.defaultSlippageBps || 30);
        config.markets = Array.isArray(config.markets) ? config.markets : [];
    }
};

export const isSensitiveField = (key: string) =>
    sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()));

export const redactSensitiveConfig = (config: any) => {
    for (const key in config) {
        if (isSensitiveField(key)) {
            delete config[key];
        } else if (typeof config[key] === 'object' && config[key] !== null) {
            redactSensitiveConfig(config[key]);
        }
    }
};

export const preserveSensitiveConfig = (config: any, oldConfig: any) => {
    sensitiveFields.forEach(field => {
        if (!config[field] && oldConfig[field]) {
            config[field] = oldConfig[field];
        }
    });
};
