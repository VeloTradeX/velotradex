import Router from 'koa-router';
import { ExchangeInstance, SignalRoute, VirtualAccount, VirtualPosition, VirtualOrder, VirtualTrade } from '../models';
import exchangeInstanceManager from '../services/exchanges';
import { GateIOExchange } from '../services/exchanges/GateIOExchange';
import { GateCFDExchange } from '../services/exchanges/GateCFDExchange';
import {
    applyDefaultConfig,
    preserveSensitiveConfig,
    redactSensitiveConfig,
} from './exchangeConfig';
import logger, { formatError } from '../utils/logger';
import { checkAdmin } from '../middleware/checkAdmin';
import systemStatusService from '../services/SystemStatusService';
import exchangeConnectionLogService from '../services/ExchangeConnectionLogService';

const router = new Router();
export { applyDefaultConfig };

export function serializeExchangeInstance(instance: ExchangeInstance): Record<string, unknown> {
    const jsonData = instance.toJSON() as any;

    if (jsonData.config) {
        try {
            const configObj = JSON.parse(jsonData.config);
            redactSensitiveConfig(configObj);
            jsonData.config = JSON.stringify(configObj);
        } catch (e) {
            // Ignore parse error
        }
    }

    return jsonData;
}

router.get('/', async (ctx) => {
    const exchanges = await ExchangeInstance.findAll();
    const instances = exchangeInstanceManager.getAllExchanges();
    const healthMap = systemStatusService.getExchangeHealthMap();
    const errorCounts = await exchangeConnectionLogService.getErrorCounts();

    // 并发拉取每台交易所的余额（getBalance 失败不影响列表返回，置 null 由前端展示占位）
    const balances = await Promise.allSettled(exchanges.map(e => {
        const instance = instances.find(i => i.id === e.id);
        if (!instance || typeof instance.getBalance !== 'function') return Promise.resolve(null);
        return instance.getBalance();
    }));

    // Merge status from memory + SystemStatusService 的健康探测结果
    const result = exchanges.map((e, idx) => {
        const instance = instances.find(i => i.id === e.id);
        const wsStats = instance && instance.getWebSocketStats ? instance.getWebSocketStats() : null;
        const jsonData = serializeExchangeInstance(e);
        const health = healthMap.get(e.id);
        const balance = balances[idx].status === 'fulfilled' ? balances[idx].value : null;

        return {
            ...jsonData,
            connected: wsStats ? wsStats.isConnected : false,
            stats: wsStats,
            // 账户余额（getBalance({currency, total, available, unrealizedPnl})），失败为 null
            balance,
            // REST 健康探测（SystemStatusService 后台采集）
            restOk: health ? health.restOk : null,
            restError: health ? health.lastRESTError : '',
            // 断连（错误）历史次数（来自 exchange_connection_logs）
            errorCount: errorCounts[e.id] || 0,
        };
    });
    ctx.body = result;
});

router.get('/:id/balance', async (ctx) => {
    const { id } = ctx.params;
    let instance: any = null;
    
    try {
        instance = exchangeInstanceManager.getExchange(id);
        const balance = await instance.getBalance('USDT'); // Default to USDT
        ctx.body = balance;
    } catch (err: any) {
        // 区分"交易所未连接"与一般错误，前端可据此展示异常状态
        const wsStats = instance && instance.getWebSocketStats ? instance.getWebSocketStats() : null;
        const disconnected = wsStats ? !wsStats.isConnected : true;
        ctx.status = disconnected ? 503 : 500;
        ctx.body = {
            error: err.message,
            exchangeConnected: !disconnected,
        };
    }
});

router.get('/:id/markets', async (ctx) => {
    const { id } = ctx.params;
    let instance: any = null;
    
    try {
        instance = exchangeInstanceManager.getExchange(id);
        const markets = await instance.getMarkets();
        ctx.body = markets.map((m: any) => ({ 
            symbol: m.symbol, 
            base: m.baseCurrency, 
            quote: m.quoteCurrency 
        }));
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.get('/:id/connection-logs', async (ctx) => {
    const { id } = ctx.params;
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 20;
    const logs = await exchangeConnectionLogService.getRecentLogs(id, Number.isFinite(limit) ? limit : 20);
    ctx.body = logs;
});

router.get('/dict/lighter_markets', async (ctx) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const dictPath = path.join(process.cwd(), 'dict/lighter_markets.json');
        const markets = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
        ctx.body = markets.map((m: any) => ({ 
            symbol: m.symbol, 
            base: m.baseCurrency, 
            quote: m.quoteCurrency 
        }));
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.post('/test', async (ctx) => {
    const { id, type, config } = ctx.request.body as any;
    
    if (!type || !config) {
        ctx.status = 400;
        ctx.body = { error: 'Missing type or config' };
        return;
    }
    
    // Apply defaults if missing
    applyDefaultConfig(type, config);
    
    try {
        // If id is provided (edit mode), merge with existing config to get secrets
        if (id) {
            const instance = await ExchangeInstance.findByPk(id);
            if (instance) {
                try {
                    const oldConfig = JSON.parse(instance.config);
                    preserveSensitiveConfig(config, oldConfig);
                } catch (e) {
                    logger.debug('Failed to parse existing exchange config for sensitive field preservation', formatError(e));
                }
            }
        }

        let exchange: any; // Use any to allow checking for testConnection
        const testConfig: any = {
            id: 'test_connection',
            name: 'Test Connection',
            type,
            ...config
        };
        
        if (type === 'virtual_gate' || type === 'virtual_gate_tradfi') {
            ctx.body = { success: true, http: true, ws: true, message: 'Virtual exchange configuration is valid' };
            return;
        }

        if (type === 'gate') {
            exchange = new GateIOExchange(testConfig);
        } else if (type === 'gate_tradfi' || type === 'gate_cfd') {
            // Gate-CFD（/tradfi/*）：前端沿用既有类型名 gate_tradfi，兼容 gate_cfd 别名
            exchange = new GateCFDExchange(testConfig);
        } else if (type === 'lighter') {
            const { LighterExchange } = await import('../services/exchanges/lighter');
            exchange = new LighterExchange(testConfig);
        } else {
            throw new Error(`Unsupported exchange type: ${type}`);
        }
        
        if (exchange && typeof exchange.testConnection === 'function') {
            const result = await exchange.testConnection();
            ctx.body = result;
        } else {
            // Fallback to getBalance
            const balance = await exchange.getBalance('USDT');
            ctx.body = { success: true, balance, message: 'Connection successful (Balance check only)' };
        }
        
    } catch (err: any) {
        ctx.status = 400; 
        ctx.body = { success: false, error: err.message, message: err.message };
    }
});

router.post('/', checkAdmin, async (ctx) => {
    const { id, type, name, config } = ctx.request.body as any;
    
    // Validate
    if (!id || !type || !config) {
        ctx.status = 400;
        ctx.body = { error: 'Missing required fields' };
        return;
    }

    // Apply defaults
    applyDefaultConfig(type, config);

    try {
        const instance = await ExchangeInstance.create({
            id, type, name, config: JSON.stringify(config), status: 'active'
        });
        
        // Notify Reload
        await exchangeInstanceManager.handleUpdate({ action: 'reload', id });
        
        ctx.body = serializeExchangeInstance(instance);
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.put('/:id', checkAdmin, async (ctx) => {
    const { id } = ctx.params;
    const { name, config, status } = ctx.request.body as any;
    
    const instance = await ExchangeInstance.findByPk(id);
    if (!instance) {
        ctx.status = 404;
        ctx.body = { error: 'Not found' };
        return;
    }

    if (name) instance.name = name;
    if (config) {
        // Handle sensitive fields: if missing/empty in new config, restore from old
        try {
            const oldConfig = JSON.parse(instance.config);
            preserveSensitiveConfig(config, oldConfig);
        } catch (e) {
            // Ignore if old config parsing fails
        }
        
        // Apply defaults
        applyDefaultConfig(instance.type, config);
        
        instance.config = JSON.stringify(config);
    }
    if (status) instance.status = status;
    
    await instance.save();
    
    // Notify Reload
    await exchangeInstanceManager.handleUpdate({ action: 'reload', id });
    
    ctx.body = serializeExchangeInstance(instance);
});

// 清空断连（错误）历史记录。
// 注意：必须注册在 router.delete('/:id') 之前，否则 DELETE /connection-logs
// 会被 '/:id' 抢先匹配（id='connection-logs'）。
router.delete('/connection-logs', checkAdmin, async (ctx) => {
    const deleted = await exchangeConnectionLogService.clearLogs();
    ctx.body = { success: true, deleted };
});

router.delete('/:id/connection-logs', checkAdmin, async (ctx) => {
    const { id } = ctx.params;
    const deleted = await exchangeConnectionLogService.clearLogs(id);
    ctx.body = { success: true, deleted };
});

router.delete('/:id', checkAdmin, async (ctx) => {
    const { id } = ctx.params;
    const instance = await ExchangeInstance.findByPk(id);
    if (!instance) {
        ctx.status = 404;
        return;
    }

    // 依赖检查：存在引用本交易所的信号路由时禁止删除，避免留下孤儿路由
    const dependentRoutes = await SignalRoute.findAll({ where: { exchangeInstanceId: id }, attributes: ['id', 'name'] });
    if (dependentRoutes.length > 0) {
        const names = dependentRoutes.map((r) => r.name).join('、');
        ctx.status = 409;
        ctx.body = { error: `该交易所被 ${dependentRoutes.length} 条信号路由依赖（${names}），请先删除或转移这些路由后再删除` };
        return;
    }

    // 依赖检查：虚拟交易所存在虚拟账户/持仓/订单/成交时禁止删除，避免留下孤立虚拟数据
    const [virtualAccounts, virtualPositions, virtualOrders, virtualTrades] = await Promise.all([
        VirtualAccount.count({ where: { exchangeInstanceId: id } }),
        VirtualPosition.count({ where: { exchangeInstanceId: id } }),
        VirtualOrder.count({ where: { exchangeInstanceId: id } }),
        VirtualTrade.count({ where: { exchangeInstanceId: id } }),
    ]);
    const virtualCount = virtualAccounts + virtualPositions + virtualOrders + virtualTrades;
    if (virtualCount > 0) {
        ctx.status = 409;
        ctx.body = {
            error: `该交易所仍有虚拟数据（${virtualAccounts} 个账户、${virtualPositions} 个持仓、${virtualOrders} 张订单、${virtualTrades} 笔成交），请先清理后再删除`,
        };
        return;
    }
    
    await instance.destroy();
    
    // Notify Delete
    await exchangeInstanceManager.handleUpdate({ action: 'delete', id });
    
    ctx.body = { success: true };
});

export default router;
