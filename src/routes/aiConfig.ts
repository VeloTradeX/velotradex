import Router from 'koa-router';
import { Op } from 'sequelize';
import { AIConfig, AILog } from '../models';
import aiParserService from '../services/AIParserService';
import { checkAdmin } from '../middleware/checkAdmin';

const router = new Router();

function normalizeExtraPayloadInput(input: unknown): string | null {
    if (input === undefined || input === null) {
        return null;
    }

    const raw = typeof input === 'string' ? input.trim() : JSON.stringify(input);
    if (!raw) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('extraPayload must be valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('extraPayload must be a JSON object');
    }

    return JSON.stringify(parsed);
}

function normalizeRequestTimeoutMs(input: unknown): number {
    if (input === undefined || input === null || input === '') {
        return 60000;
    }

    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('requestTimeoutMs must be a positive number');
    }

    return Math.floor(value);
}

type QueryValue = string | string[] | undefined;

const asString = (value: QueryValue): string | undefined => {
    if (Array.isArray(value)) return value[0];
    return value;
};

const buildRouteIdFilter = (routeId: string) => {
    return {
        [Op.or]: [
            { routeIds: JSON.stringify([Number(routeId)]) },
            { routeIds: { [Op.like]: `[${routeId},%` } },
            { routeIds: { [Op.like]: `%,${routeId},%` } },
            { routeIds: { [Op.like]: `%,${routeId}]` } },
        ],
    };
};

export const listAILogs = async (query: Record<string, QueryValue>) => {
    const page = Number(asString(query.page) || 1);
    const limit = Number(asString(query.limit) || 20);
    const offset = (page - 1) * limit;
    const where: any = {};
    const strategyId = asString(query.strategyId);
    const routeId = asString(query.routeId);

    if (strategyId) {
        where.strategyId = strategyId;
    }

    if (routeId) {
        Object.assign(where, buildRouteIdFilter(routeId));
    }

    const { count, rows } = await AILog.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
        attributes: { exclude: ['imageBase64', 'systemPrompt'] }
    });

    return {
        total: count,
        page,
        limit,
        logs: rows
    };
};

// GET /api/ai-config
router.get('/', async (ctx) => {
    const config = await AIConfig.findOne({ where: { isActive: true } });
    if (!config) {
        ctx.body = null;
    } else {
        const configJson: any = config.toJSON();
        if (configJson.apiKey && configJson.apiKey.length > 4) {
            configJson.apiKey = '****' + configJson.apiKey.slice(-4);
        } else if (configJson.apiKey) {
            configJson.apiKey = '****';
        }
        ctx.body = configJson;
    }
});

// POST /api/ai-config
router.post('/', async (ctx) => {
    const { provider, apiKey, baseUrl, textModel, visionModel, stripChinese, extraPayload, requestTimeoutMs, promptTemplate, mode, contextMessageCount } = ctx.request.body as any;
    
    // Validate inputs
    if (!provider || !apiKey || (!textModel && !visionModel)) {
        ctx.status = 400;
        ctx.body = { error: 'Missing required fields' };
        return;
    }

    try {
        // Deactivate old configs
        await AIConfig.update({ isActive: false }, { where: { isActive: true } });

        const config = await AIConfig.create({
            provider,
            apiKey,
            baseUrl,
            textModel,
            visionModel,
            stripChinese,
            extraPayload: normalizeExtraPayloadInput(extraPayload),
            requestTimeoutMs: normalizeRequestTimeoutMs(requestTimeoutMs),
            promptTemplate,
            mode,
            contextMessageCount,
            isActive: true
        });

        // Reload service
        await aiParserService.reloadConfig();
        
        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// PUT /api/ai-config/:id
router.put('/:id', async (ctx) => {
    const { id } = ctx.params;
    const { provider, apiKey, baseUrl, textModel, visionModel, stripChinese, extraPayload, requestTimeoutMs, promptTemplate, mode, contextMessageCount } = ctx.request.body as any;

    const config = await AIConfig.findByPk(id);
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Config not found' };
        return;
    }

    try {
        if (provider) config.provider = provider;
        if (apiKey) config.apiKey = apiKey;
        if (baseUrl !== undefined) config.baseUrl = baseUrl;
        if (textModel) config.textModel = textModel;
        if (visionModel) config.visionModel = visionModel;
        if (stripChinese !== undefined) config.stripChinese = stripChinese;
        if (extraPayload !== undefined) config.extraPayload = normalizeExtraPayloadInput(extraPayload);
        if (requestTimeoutMs !== undefined) config.requestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
        if (promptTemplate) config.promptTemplate = promptTemplate;
        if (mode) config.mode = mode;
        if (contextMessageCount !== undefined) config.contextMessageCount = contextMessageCount;

        await config.save();
        
        // Reload service
        await aiParserService.reloadConfig();

        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// POST /api/ai-config/test
router.post('/test', async (ctx) => {
    const config = ctx.request.body;
    try {
        const result = await aiParserService.testConfig(config);
        ctx.body = result;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, message: e.message };
    }
});

// GET /api/ai-config/models
// Change to POST to support passing credentials in body
router.post('/models', async (ctx) => {
    try {
        const { apiKey, baseUrl, requestTimeoutMs } = ctx.request.body as any;
        const models = await aiParserService.getModels({ apiKey, baseUrl, requestTimeoutMs });
        ctx.body = models;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// GET /api/ai-config/logs
router.get('/logs', async (ctx) => {
    try {
        ctx.body = await listAILogs(ctx.query as Record<string, QueryValue>);
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// GET /api/ai-config/logs/:id
router.get('/logs/:id', async (ctx) => {
    try {
        const log = await AILog.findByPk(ctx.params.id);
        if (!log) {
            ctx.status = 404;
            ctx.body = { error: 'Log not found' };
            return;
        }
        ctx.body = log;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// POST /api/ai-config/logs/:id/retry
router.post('/logs/:id/retry', checkAdmin, async (ctx) => {
    try {
        const log = await AILog.findByPk(ctx.params.id);
        if (!log) {
            ctx.status = 404;
            ctx.body = { error: 'Log not found' };
            return;
        }

        const retried = await aiParserService.retryLogAnalysis(log);
        if (!retried) {
            ctx.status = 503;
            ctx.body = { error: 'AI parser is not configured' };
            return;
        }
        if (!retried.logId) {
            ctx.status = 500;
            ctx.body = { error: 'Retry log persistence failed' };
            return;
        }

        const retriedLog = await AILog.findByPk(retried.logId);

        const response: any = {
            success: true,
            logId: retried.logId,
            warning: log.systemPrompt ? undefined : 'This log was created before systemPrompt persistence. The retry used the saved user prompt only.',
            result: {
                content: retried.content,
                usage: retried.usage,
            },
            log: retriedLog,
        };

        // --- triggerOrder: optionally execute full order flow after successful re-parse ---
        const { triggerOrder } = (ctx.request.body as any) || {};
        if (triggerOrder === true) {
            const { Strategy, SignalRoute } = require('../models');
            const strategyParserRegistry = require('../services/parsers').default;
            const { applyAIResultToParsedStrategy, normalizeRouteSymbol } = require('../services/RouteParsedStrategy');
            const parserConfigService = require('../services/ParserConfigService').default;
            const tradeExecutor = require('../services/TradeExecutor').default;

            // Check strategyId on log
            if (!log.strategyId) {
                response.warning = 'Cannot trigger order: log has no associated strategyId';
                ctx.body = response;
                return;
            }

            // Find Strategy
            const strategy = await Strategy.findByPk(log.strategyId);
            if (!strategy) {
                response.warning = 'Cannot trigger order: Strategy not found';
                ctx.body = response;
                return;
            }

            // Parse AI result from re-parsed content
            let aiResult: any = null;
            try {
                const rawContent = typeof retried.content === 'string' ? retried.content : (retried.content != null ? JSON.stringify(retried.content) : '');
                if (!rawContent) {
                    response.warning = 'Cannot trigger order: AI returned empty content, unable to parse';
                    ctx.body = response;
                    return;
                }
                const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
                aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawContent);
                if (!aiResult || typeof aiResult !== 'object') {
                    response.warning = 'Cannot trigger order: AI result is not a valid JSON object';
                    ctx.body = response;
                    return;
                }
            } catch {
                response.warning = 'Cannot trigger order: failed to parse AI result JSON';
                ctx.body = response;
                return;
            }

            // Check action=ignore
            if (aiResult.action === 'ignore') {
                response.warning = 'Cannot trigger order: AI marked signal as ignore';
                ctx.body = response;
                return;
            }

            // Check confidence < 0.5
            const confidence = Number(aiResult.confidence);
            if (Number.isFinite(confidence) && confidence < 0.5) {
                response.warning = `Cannot trigger order: AI confidence too low (${confidence.toFixed(2)} < 0.50)`;
                ctx.body = response;
                return;
            }

            // Find SignalRoute from log.routeIds
            let routeId: number | undefined;
            try {
                const parsed = JSON.parse(log.routeIds || '[]');
                if (Array.isArray(parsed) && parsed.length > 0) {
                    routeId = parsed[0];
                }
            } catch {}

            if (!routeId) {
                response.warning = 'Cannot trigger order: log has no routeId';
                ctx.body = response;
                return;
            }

            const route = await SignalRoute.findByPk(routeId);
            if (!route || !route.isActive) {
                response.warning = 'Cannot trigger order: route not found or disabled';
                ctx.body = response;
                return;
            }

            // Update Strategy.aiAnalysis
            strategy.aiAnalysis = JSON.stringify(aiResult);
            await strategy.save();

            // Rebuild ParsedStrategy
            const parserName = strategy.parserName || 'DefaultParser';
            const parser = strategyParserRegistry.getParserByName(parserName);
            if (!parser) {
                response.warning = `Cannot trigger order: parser "${parserName}" not found`;
                ctx.body = response;
                return;
            }

            let rawMessage: any = strategy.rawMessage;
            try { rawMessage = JSON.parse(rawMessage); } catch {}
            const parsedStrategies = await parser.parse(rawMessage);
            if (!parsedStrategies || parsedStrategies.length === 0) {
                response.warning = 'Cannot trigger order: parser returned no strategies';
                ctx.body = response;
                return;
            }

            let routeParsed = applyAIResultToParsedStrategy(parsedStrategies[0], aiResult);
            routeParsed.symbol = normalizeRouteSymbol(routeParsed.symbol);

            // Get riskConfig
            let defaultConfig = parser.getRiskConfig();
            let riskConfig = await parserConfigService.getEffectiveConfig(parser.name, defaultConfig);

            // Route risk override
            if (route.riskSettings) {
                try {
                    const routeRisk = JSON.parse(route.riskSettings);
                    if (routeRisk.positionSizingMode === 'ratio_based') {
                        routeRisk.riskMode = 'ratio_based';
                        if (!routeRisk.riskValue || routeRisk.riskValue === 10) {
                            routeRisk.riskValue = 1;
                        }
                        delete routeRisk.positionSizingMode;
                    }
                    riskConfig = { ...riskConfig, ...routeRisk };
                } catch {}
            }

            // Symbol specific override
            if (route.symbolSpecificSettings) {
                try {
                    const specificSettings = JSON.parse(route.symbolSpecificSettings);
                    const symbolConfig = specificSettings[routeParsed.symbol];
                    if (symbolConfig && symbolConfig.riskValue !== undefined && symbolConfig.riskValue !== '') {
                        const val = Number(symbolConfig.riskValue);
                        if (!isNaN(val)) {
                            riskConfig = { ...riskConfig, riskValue: val };
                        }
                    }
                } catch {}
            }

            // Execute trade
            let orderResult: any;
            try {
                orderResult = await tradeExecutor.execute(
                    routeParsed,
                    riskConfig,
                    strategy.source,
                    strategy.id,
                    route.exchangeInstanceId,
                    route.id
                );
            } catch (execErr: any) {
                response.warning = `Cannot trigger order: trade execution failed - ${execErr.message}`;
                ctx.body = response;
                return;
            }

            response.orderResult = orderResult;
        }

        ctx.body = response;
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message };
    }
});

export default router;
