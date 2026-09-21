import Router from 'koa-router';
import { Op } from 'sequelize';
import { SignalRoute, Order, StrategyPosition } from '../models';
import routingService from '../services/RoutingService';
import strategyParserRegistry from '../services/parsers';
import logger, { formatError } from '../utils/logger';

const router = new Router();

/**
 * 校验信号路由 riskSettings 中新增的价格调整体系/入场点选择字段。
 * 返回错误文案；null 表示通过。
 */
function validateRiskSettingsFields(riskSettings: any): string | null {
    if (!riskSettings || typeof riskSettings !== 'object') return null;

    const paddingMode = riskSettings.paddingMode;
    if (paddingMode !== undefined && paddingMode !== null && paddingMode !== '' && paddingMode !== 'r' && paddingMode !== 'fixed') {
        return 'paddingMode 必须为 "r"（R 百分比体系）或 "fixed"（固定金额体系）';
    }

    for (const field of ['entryOffsetFixed', 'fixedSlDistance', 'slBackOffsetFixed']) {
        const value = riskSettings[field];
        if (value === undefined || value === null || value === '') continue;
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) {
            return `${field} 必须为非负数字（美元）`;
        }
    }

    const entrySelection = riskSettings.entrySelection;
    if (entrySelection !== undefined && entrySelection !== null && entrySelection !== '' && entrySelection !== 'all' && entrySelection !== 'nearest_sl') {
        return 'entrySelection 必须为 "all"（全部入场）或 "nearest_sl"（仅最靠近止损的入场点）';
    }

    return null;
}

router.get('/', async (ctx) => {
    const routes = await SignalRoute.findAll();
    ctx.body = routes;
});

router.get('/:id/details', async (ctx) => {
    const { id } = ctx.params;
    const route = await SignalRoute.findByPk(id);
    if (!route) {
        ctx.status = 404;
        ctx.body = { error: 'Route not found' };
        return;
    }

    // 1. Database Config
    let dbConfig = {};
    try {
        dbConfig = route.riskSettings ? JSON.parse(route.riskSettings) : {};
    } catch (e) {
        logger.debug('Failed to parse riskSettings JSON for route details', formatError(e));
    }

    // 2. Default Config from Parser
    const parserName = route.parser || 'DefaultParser';
    const parser = strategyParserRegistry.getParserByName(parserName);
    const defaultConfig = parser ? parser.getRiskConfig() : {};

    // 3. Effective Config (Merged)
    // Usually it's shallow merge for risk config.
    const effectiveConfig = { ...defaultConfig, ...dbConfig };

    ctx.body = {
        route,
        dbConfig,
        defaultConfig,
        effectiveConfig,
        parserName: parser ? parser.name : 'Unknown'
    };
});

router.post('/', async (ctx) => {
    const { name, channelId, exchangeInstanceId, riskSettings, isActive, parser, supportedSymbols, symbolSpecificSettings, aiMode } = ctx.request.body as any;
    
    if (!parser) {
        ctx.status = 400;
        ctx.body = { error: 'Parser is required' };
        return;
    }

    // 校验新增风控字段（价格调整体系 / 入场点选择）
    const riskSettingsError = validateRiskSettingsFields(riskSettings);
    if (riskSettingsError) {
        ctx.status = 400;
        ctx.body = { error: riskSettingsError };
        return;
    }

    // Validation for Percentage Risk Mode
    try {
        const pInstance = strategyParserRegistry.getParserByName(parser);
        const defaultConfig = pInstance ? pInstance.getRiskConfig() : {};
        const effectiveRiskMode = (riskSettings as any)?.riskMode || (defaultConfig as any).riskMode;
        
        if (effectiveRiskMode === 'percentage' && symbolSpecificSettings) {
            for (const [symbol, config] of Object.entries(symbolSpecificSettings)) {
                const val = Number((config as any).riskValue);
                if (!isNaN(val) && val > 50) {
                    ctx.status = 400;
                    ctx.body = { error: `Risk value for ${symbol} cannot exceed 50%` };
                    return;
                }
            }
        }
    } catch (e) {
        // Ignore validation error if parser not found or structure invalid, let it save
    }

    try {
        const route = await SignalRoute.create({
            name, 
            channelId, 
            exchangeInstanceId,
            parser,
            riskSettings: riskSettings ? JSON.stringify(riskSettings) : '{}',
            supportedSymbols: supportedSymbols ? JSON.stringify(supportedSymbols) : '[]',
            symbolSpecificSettings: symbolSpecificSettings ? JSON.stringify(symbolSpecificSettings) : '{}',
            isActive: isActive !== undefined ? isActive : true,
            aiMode: aiMode || 'disabled'
        });
        
        await routingService.reloadRoutes();

        ctx.body = route;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.put('/:id', async (ctx) => {
    const { id } = ctx.params;
    const body = ctx.request.body as any;

    const route = await SignalRoute.findByPk(id);
    if (!route) {
        ctx.status = 404;
        ctx.body = { error: 'Route not found' };
        return;
    }

    // 校验新增风控字段（价格调整体系 / 入场点选择）
    const riskSettingsError = validateRiskSettingsFields(body.riskSettings);
    if (riskSettingsError) {
        ctx.status = 400;
        ctx.body = { error: riskSettingsError };
        return;
    }

    // Validation
    try {
        const parserName = body.parser || route.parser;
        const pInstance = strategyParserRegistry.getParserByName(parserName);
        const defaultConfig = pInstance ? pInstance.getRiskConfig() : {};
        
        let riskSettings = {};
        if (body.riskSettings) {
             riskSettings = body.riskSettings;
        } else if (route.riskSettings) {
             try { riskSettings = JSON.parse(route.riskSettings); } catch(e) {
                 logger.debug('Failed to parse riskSettings JSON', formatError(e));
             }
        }
        
        const effectiveRiskMode = (riskSettings as any).riskMode || (defaultConfig as any).riskMode;
        
        if (effectiveRiskMode === 'percentage' && body.symbolSpecificSettings) {
             for (const [symbol, config] of Object.entries(body.symbolSpecificSettings)) {
                 const val = Number((config as any).riskValue);
                 if (!isNaN(val) && val > 50) {
                     ctx.status = 400;
                     ctx.body = { error: `Risk value for ${symbol} cannot exceed 50%` };
                     return;
                 }
             }
        }
    } catch (e) {
        // Ignore validation error
    }
    
    if (body.name) route.name = body.name;
    if (body.channelId) route.channelId = body.channelId;
    if (body.exchangeInstanceId) route.exchangeInstanceId = body.exchangeInstanceId;
    if (body.parser) route.parser = body.parser;
    if (body.riskSettings) route.riskSettings = JSON.stringify(body.riskSettings);
    if (body.supportedSymbols) route.supportedSymbols = JSON.stringify(body.supportedSymbols);
    if (body.symbolSpecificSettings) route.symbolSpecificSettings = JSON.stringify(body.symbolSpecificSettings);
    if (body.isActive !== undefined) route.isActive = body.isActive;
    if (body.aiMode !== undefined) (route as any).aiMode = body.aiMode;
    
    await route.save();
    await routingService.reloadRoutes();

    ctx.body = route;
});

router.delete('/:id', async (ctx) => {
    const { id } = ctx.params;

    const route = await SignalRoute.findByPk(id);
    if (!route) {
        ctx.status = 404;
        ctx.body = { error: 'Route not found' };
        return;
    }

    // 依赖检查：路由下仍有未关闭订单/持仓时禁止删除，避免交易记录失去归属
    const openOrders = await Order.count({
        where: {
            routeId: id,
            [Op.not]: {
                [Op.or]: [
                    { lifecycleStatus: 'CLOSED' },
                    { status: { [Op.in]: ['closed', 'cancelled'] } },
                ],
            },
        },
    });
    const openPositions = await StrategyPosition.count({
        where: { routeId: id, status: { [Op.ne]: 'CLOSED' } },
    });

    if (openOrders > 0 || openPositions > 0) {
        ctx.status = 409;
        ctx.body = { error: `该路由下仍有 ${openOrders} 张未关闭订单、${openPositions} 个未关闭持仓，请先处理后再删除该路由` };
        return;
    }

    await SignalRoute.destroy({ where: { id } });
    await routingService.reloadRoutes();
    ctx.body = { success: true };
});

export default router;
