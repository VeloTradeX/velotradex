import Router from 'koa-router';
import { Op, Sequelize } from 'sequelize';
import { Strategy, Order, User, AuditLog } from '../models';
import exchangeRegistry from '../services/exchanges';
import strategyParserRegistry from '../services/parsers';
import redisService from '../services/RedisService';
import statsService from '../services/StatsService';
import tradingStatsService from '../services/TradingStatsService';
import tradeExecutor from '../services/TradeExecutor';
import marketService from '../services/MarketService';
import orderQueryService from '../services/OrderQueryService';
import config from '../config';
import { authMiddleware } from '../middleware/auth';
import { auditMiddleware } from '../middleware/audit';
import fs from 'fs';
import path from 'path';
import { signAuthTokens, verifyRefreshToken } from '../services/AuthTokenService';

import { listFormalOrders, applyDateRange } from './orderQueries';

import parserRoutes from './parser';
import exchangeRoutes from './exchange';
import routeRoutes from './route';
import userRoutes from './user';
import auditRoutes from './audit';
import logRoutes from './logs';
import backupRoutes from './backup';
import webhookRoutes from './webhook';
import aiConfigRoutes from './aiConfig';
import virtualExchangeRoutes from './virtualExchange';
import apiCredentialRoutes from './apiCredentials';
import tradeRoutes from './trade';
// 历史回测功能暂时不可用，恢复时取消注释
// import backtestRoutes from './backtest';
import healthRoutes from './health';
import systemStatusService from '../services/SystemStatusService';
import { RateLimiter } from '../utils/rateLimiter';
import { apiCredentialScopeMiddleware } from '../middleware/apiCredentialScope';

const loginLimiter = new RateLimiter(5, 60_000); // 5 attempts per minute per IP

/**
 * Injectable dependencies for the main router. Each entry falls back to the
 * process-wide singleton when omitted, so `createRouter()` (and therefore the
 * default export) keeps the previous behaviour while callers/tests can inject
 * explicit mocks or alternate instances in a composition-root style.
 */
export interface RouterDeps {
  tradeExecutor?: typeof tradeExecutor;
  exchangeRegistry?: typeof exchangeRegistry;
  marketService?: typeof marketService;
  orderQueryService?: typeof orderQueryService;
  statsService?: typeof statsService;
  tradingStatsService?: typeof tradingStatsService;
  config?: typeof config;
}

export function createRouter(depsIn: Partial<RouterDeps> = {}): Router {
  const d: Required<RouterDeps> = {
    tradeExecutor: depsIn.tradeExecutor ?? tradeExecutor,
    exchangeRegistry: depsIn.exchangeRegistry ?? exchangeRegistry,
    marketService: depsIn.marketService ?? marketService,
    orderQueryService: depsIn.orderQueryService ?? orderQueryService,
    statsService: depsIn.statsService ?? statsService,
    tradingStatsService: depsIn.tradingStatsService ?? tradingStatsService,
    config: depsIn.config ?? config,
  };

  const router = new Router();

// --- Auth ---

router.post('/api/auth/login', async (ctx) => {
  const clientIp = ctx.ip || 'unknown';
  if (loginLimiter.isLimited(clientIp)) {
    ctx.status = 429;
    ctx.body = { error: 'Too many login attempts. Please try again later.' };
    return;
  }

  const { username, password } = ctx.request.body as any;
  const user = await User.findOne({ where: { username } });

  if (!user || !(await user.validatePassword(password))) {
    ctx.status = 401;
    ctx.body = { error: 'Invalid credentials' };
    return;
  }

  const tokens = signAuthTokens({ id: user.id, username: user.username, role: user.role });

  ctx.body = { ...tokens, user: { username: user.username, role: user.role } };
});

router.post('/api/auth/refresh', async (ctx) => {
  const { refreshToken } = ctx.request.body as any;

  if (!refreshToken || typeof refreshToken !== 'string') {
    ctx.status = 401;
    ctx.body = { error: 'Invalid or expired refresh token' };
    return;
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findByPk(decoded.id);

    if (!user) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid or expired refresh token' };
      return;
    }

    const tokens = signAuthTokens(
      { id: user.id, username: user.username, role: user.role },
      { absExp: decoded.absExp }
    );
    ctx.body = { ...tokens, user: { username: user.username, role: user.role } };
  } catch (error) {
    ctx.status = 401;
    ctx.body = { error: 'Invalid or expired refresh token' };
  }
});

// --- Health (public, no auth) ---
// 必须注册在下面的 `/api/*` 鉴权中间件之前，否则会被拦截成 401。
router.use(healthRoutes.routes(), healthRoutes.allowedMethods());

// Protected Routes Middleware
router.use('/api/*', async (ctx, next) => {
  const publicPaths = ['/api/auth/login', '/api/auth/refresh', '/api/market/candles'];
  if (publicPaths.some(p => ctx.path === p || ctx.path === p + '/')) {
    await next();
    return;
  }
  await authMiddleware(ctx as any, next);
});

// API Credential Scope Middleware (after Auth, before Audit)
router.use('/api/*', (ctx, next) => apiCredentialScopeMiddleware(ctx as any, next));

// Audit Middleware (after Auth so we have user info)
router.use('/api/*', (ctx, next) => auditMiddleware(ctx as any, next));

router.use('/api/parsers', parserRoutes.routes(), parserRoutes.allowedMethods());
router.use('/api/exchanges', exchangeRoutes.routes(), exchangeRoutes.allowedMethods());
router.use('/api/routes', routeRoutes.routes(), routeRoutes.allowedMethods());
router.use('/api/users', userRoutes.routes(), userRoutes.allowedMethods());
router.use('/api/audit-logs', auditRoutes.routes(), auditRoutes.allowedMethods());
router.use('/api/logs', logRoutes.routes(), logRoutes.allowedMethods());
router.use('/api/backup', backupRoutes.routes(), backupRoutes.allowedMethods());
router.use('/api/webhooks', webhookRoutes.routes(), webhookRoutes.allowedMethods());
router.use('/api/ai-config', aiConfigRoutes.routes(), aiConfigRoutes.allowedMethods());
router.use('/api/virtual-exchange', virtualExchangeRoutes.routes(), virtualExchangeRoutes.allowedMethods());
router.use('/api/trades', tradeRoutes.routes(), tradeRoutes.allowedMethods());
// 历史回测功能暂时不可用，恢复时取消注释
// router.use('/api/backtest', backtestRoutes.routes(), backtestRoutes.allowedMethods());
router.use('/api/api-credentials', apiCredentialRoutes.routes(), apiCredentialRoutes.allowedMethods());

router.post('/api/auth/change-password', async (ctx) => {
  const clientIp = ctx.ip || 'unknown';
  if (loginLimiter.isLimited(clientIp)) {
    ctx.status = 429;
    ctx.body = { error: 'Too many login attempts. Please try again later.' };
    return;
  }

  const { oldPassword, newPassword } = ctx.request.body as any;
  const userId = ctx.state.user.id;
  const user = await User.findByPk(userId);

  if (!user || !(await user.validatePassword(oldPassword))) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid old password' };
    return;
  }

  user.password = newPassword; // Hook handles hashing
  await user.save();
  ctx.body = { success: true };
});

// --- KOLs / Strategies ---

router.get('/api/config/redis-channel', async (ctx) => {
  ctx.body = { channel: d.config.redis.msgChannel };
});

// 系统健康状态：Redis / 数据库 / 交易所（WS + REST）聚合状态。
// 由 SystemStatusService 后台定时收集（15s），此处仅返回缓存快照，永不阻塞。
router.get('/api/status', async (ctx) => {
  ctx.body = systemStatusService.getStatus();
});

router.get('/api/config/trading-mode', async (ctx) => {
  ctx.body = {
    mode: d.config.trading.mode,
    enableTrading: d.config.enableTrading
  };
});

router.get('/api/version', async (ctx) => {
  try {
    const versionPath = path.join(__dirname, '../../version.json');
    const versionContent = fs.readFileSync(versionPath, 'utf8');
    const versionData = JSON.parse(versionContent);
    ctx.body = versionData;
  } catch (error) {
    ctx.body = { version: '' };
  }
});

router.post('/api/message/send', async (ctx) => {
  const { content } = ctx.request.body as any;
  if (!content) {
    ctx.status = 400;
    ctx.body = { error: 'Content is required' };
    return;
  }
  
  try {
    const messageStr = typeof content === 'string' ? content : JSON.stringify(content);
    await redisService.publish(d.config.redis.msgChannel, messageStr);
    ctx.body = { success: true };
  } catch (error: any) {
    // Redis 不可用时给出明确提示，而不是笼统的 500
    const redisStatus = redisService.getStatus();
    const message = !redisStatus.ready
      ? `Redis 未连接（sub:${redisStatus.subStatus}, pub:${redisStatus.pubStatus}），消息发送失败`
      : error.message;
    ctx.status = 503;
    ctx.body = { error: message, redisConnected: redisStatus.ready };
  }
});

router.post('/api/parser/test', async (ctx) => {
  const { channelId, content, parser: parserName } = ctx.request.body as any;
  if (!content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required' };
    return;
  }

  let parser: any = null;

  if (parserName) {
    parser = strategyParserRegistry.getParserByName(parserName);
  } else if (channelId) {
    // Try to find parser by channelId via SignalRoute
    const route = await import('../models/SignalRoute').then(m => m.default.findOne({ where: { channelId } }));
    if (route && route.parser) {
      parser = strategyParserRegistry.getParserByName(route.parser);
    }
  }

  if (!parser) {
    // Fallback: try default parser if nothing else works, or just fail
    // The old code used getParser(channelId) which returned null.
    // Let's try to find a default parser if possible? No, explicit is better.
    ctx.status = 404;
    ctx.body = { error: 'Parser not found. Please provide a valid parser name or channel ID.' };
    return;
  }

  try {
    // The content from frontend might be a JSON object or string.
    // Parsers usually expect the raw object (as parsed from Redis JSON).
    const messageObj = typeof content === 'string' ? JSON.parse(content) : content;
    
    // Inject channel_id if missing, as some parsers might rely on it (though usually they don't if invoked directly)
    if (!messageObj.channel_id && channelId) {
        messageObj.channel_id = channelId;
    }

    const result = await parser.parse(messageObj, true);
    ctx.body = { result };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/strategies', async (ctx) => {
  try {
    const strategies = await listStrategies({
      limit: ctx.query.limit ? parseInt(ctx.query.limit as string) : undefined,
      parser: ctx.query.parser as string,
      symbol: ctx.query.symbol as string,
      startDate: ctx.query.startDate as string,
      endDate: ctx.query.endDate as string,
      backtestRunId: ctx.query.backtestRunId as string | undefined,
    });
    ctx.body = strategies;
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/strategies/:id/details', async (ctx) => {
  try {
    const result = await getStrategyDetails(ctx.params.id);
    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'Strategy not found' };
      return;
    }
    ctx.body = result;
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

// --- Orders (History & Current) ---

router.get('/api/orders/filters', async (ctx) => {
  try {
    const liveOnly = { backtestRunId: { [Op.is]: null } };
    const symbols = await Order.findAll({
      attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('symbol')), 'symbol']],
      where: liveOnly,
      raw: true
    }) as any[];

    const sources = await Order.findAll({
      attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('source')), 'source']],
      where: liveOnly,
      raw: true
    }) as any[];
    
    ctx.body = {
      symbols: symbols.map(s => s.symbol).filter(Boolean).sort(),
      sources: sources.map(s => s.source).filter(Boolean).sort()
    };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/orders', async (ctx) => {
  try {
    ctx.body = await listFormalOrders(ctx.query as any, 50);
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/orders/history', async (ctx) => {
  try {
    ctx.body = await listFormalOrders(ctx.query as any, 100);
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/orders/:id/audit', async (ctx) => {
  const orderId = parseInt(ctx.params.id);
  if (isNaN(orderId)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid order ID' };
    return;
  }

  try {
    // Find logs for this order ID specifically
    // We might also want to include logs that are related to the strategy if we want a wider view,
    // but the user asked for "history of an order".
    // However, some logs might be linked via strategyId but have orderId=null (e.g. strategy creation).
    // Let's first fetch the order to get its strategyId.
    const order = await Order.findByPk(orderId);
    
    const whereClause: any = { orderId };
    
    // If we want to include strategy-level logs (like signal parsing) that led to this order,
    // we would need to fetch logs with strategyId = order.strategyId AND orderId IS NULL.
    // But for simplicity and strict "order audit", let's stick to orderId first.
    // User requirement: "full link tracking... from signal matched... to order finished"
    // So we SHOULD include strategy level logs if possible.
    
    let logs;
    if (order && order.strategyId) {
        logs = await AuditLog.findAll({
            where: {
                [Op.or]: [
                    { orderId: orderId },
                    { strategyId: order.strategyId } 
                ]
            },
            order: [['createdAt', 'ASC']]
        });
    } else {
        // Fallback if order not found or no strategyId (shouldn't happen for valid orders)
        logs = await AuditLog.findAll({
            where: { orderId },
            order: [['createdAt', 'ASC']]
        });
    }

    ctx.body = logs;
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/orders/open', async (ctx) => {
  ctx.body = await d.orderQueryService.getOpenOrders(ctx.query.symbol as string);
});

// --- Positions ---

router.get('/api/positions', async (ctx) => {
  ctx.body = await d.orderQueryService.getPositions(ctx.query.exchangeInstanceId);
});

router.get('/api/positions/history', async (ctx) => {
    try {
        const page = parseInt(ctx.query.page as string) || 1;
        const pageSize = parseInt(ctx.query.pageSize as string) || 20;
        const exchangeInstanceId = ctx.query.exchangeInstanceId as string;
        
        const where: any = {
            lifecycleStatus: 'CLOSED',
            // 回测数据隔离：默认只看实盘平仓记录
            backtestRunId: { [Op.is]: null },
        };

        if (exchangeInstanceId) {
            where.exchangeInstanceId = exchangeInstanceId;
        }
        
        const { count, rows } = await Order.findAndCountAll({
            where,
            order: [['closedAt', 'DESC'], ['updatedAt', 'DESC']],
            limit: pageSize,
            offset: (page - 1) * pageSize
        });
        
        ctx.body = {
            total: count,
            data: rows
        };
    } catch (error: any) {
        ctx.status = 500;
        ctx.body = { error: error.message };
    }
});



router.get('/api/exchange/stats', async (ctx) => {
  const exchange = d.exchangeRegistry.getExchange();
  if (exchange.getWebSocketStats) {
      ctx.body = exchange.getWebSocketStats();
  } else {
      ctx.body = { error: 'Not supported by current exchange' };
  }
});

router.post('/api/orders/:id/cancel', async (ctx) => {
  const orderId = ctx.params.id;
  const order = await Order.findByPk(orderId);
  
  if (!order) {
    ctx.status = 404;
    ctx.body = { error: 'Order not found' };
    return;
  }

  // 按订单所属的交易所实例路由，而不是默认（第一个注册）交易所。
  // 否则多实例环境下取消失败（exchangeOrderId 属于其他实例）。
  let exchange;
  try {
    exchange = d.exchangeRegistry.getExchange(order.exchangeInstanceId as string);
  } catch {
    // 订单无 exchangeInstanceId 或实例不存在时回退到默认实例
    exchange = d.exchangeRegistry.getExchange();
  }
  try {
    // Note: exchangeOrderId might be needed, or we might need to handle simulated orders
    const result = await exchange.cancelOrder(order.exchangeOrderId, order.symbol);
    
    // Update order status if successful
    if (result) {
        order.status = 'cancelled';
        await order.save();
    }
    
    ctx.body = { success: result };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.post('/api/positions/close', async (ctx) => {
  const {
    symbol,
    side,
    exchangeInstanceId,
    strategyId,
    orderId,
    closeAmount,
    closePercentage,
    closePrice,
    source,
    routeId,
    parserName
  } = ctx.request.body as any;
  
  if (!symbol || !side) {
    ctx.status = 400;
    ctx.body = { error: 'Symbol and side are required' };
    return;
  }

  try {
    const parsedStrategyId = Number.isFinite(Number(strategyId)) ? Number(strategyId) : undefined;
    const parsedRouteId = Number.isFinite(Number(routeId)) ? Number(routeId) : undefined;
    const result = await d.tradeExecutor.manualClosePosition({
      symbol,
      side,
      exchangeInstanceId,
      strategyId: parsedStrategyId,
      orderId: orderId ? String(orderId) : undefined,
      closeAmount: closeAmount ? String(closeAmount) : undefined,
      closePercentage: Number.isFinite(Number(closePercentage)) ? Number(closePercentage) : undefined,
      closePrice: closePrice ? String(closePrice) : undefined,
      source: source ? String(source) : undefined,
      routeId: parsedRouteId,
      parserName: parserName ? String(parserName) : undefined
    });
    ctx.body = { success: result?.status === 'filled', result };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/stats', async (ctx) => {
  try {
    const stats = await d.statsService.getStats();
    ctx.body = stats;
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/api/stats/trading', async (ctx) => {
  const { days, routeId, backtestRunId } = ctx.query;
  try {
    const daysNum = days ? parseInt(days as string) : 30; // Default 30 days
    const routeIdNum = routeId ? parseInt(routeId as string) : undefined;
    // backtestRunId=数字查看指定回测的统计；否则默认实盘（排除回测数据）
    const btRunNum = backtestRunId && Number.isFinite(Number(backtestRunId)) && backtestRunId !== 'all'
      ? Number(backtestRunId)
      : undefined;
    const stats = await d.tradingStatsService.getStats(daysNum, routeIdNum, btRunNum);
    ctx.body = stats;
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

// --- Market Data Proxy ---

router.get('/api/market/candles', async (ctx) => {
  try {
    ctx.body = await d.marketService.getCandles(ctx.query as any);
  } catch (error: any) {
    ctx.status = error.status || 500;
    ctx.body = { error: error.message };
  }
});

  return router;
}

export default createRouter();

// --- Strategies (process-level queries reused by routes & external callers) ---

export async function listStrategies(params: { limit?: number; parser?: string; symbol?: string; startDate?: string; endDate?: string; backtestRunId?: string }) {
  const { limit = 50, parser, symbol, startDate, endDate, backtestRunId } = params;

  const where: any = {};
  if (parser) where.parserName = parser;
  if (symbol) where.symbol = symbol;

  // 回测数据隔离：默认只看实盘；backtestRunId=数字看指定回测；backtestRunId=all 全部
  if (backtestRunId === 'all') {
    // 不过滤
  } else if (backtestRunId && Number.isFinite(Number(backtestRunId))) {
    where.backtestRunId = Number(backtestRunId);
  } else {
    where.backtestRunId = { [Op.is]: null };
  }

  const query: any = { startDate, endDate };
  applyDateRange(where, query, 'createdAt');

  const strategies = await Strategy.findAll({
    where,
    limit,
    order: [['createdAt', 'DESC']],
    include: [{ model: Order, as: 'Orders', attributes: ['id'] }],
  });

  return strategies.map((s: any) => {
    const data = s.get({ plain: true });
    const orderCount = data.Orders ? data.Orders.length : 0;
    const { Orders, ...rest } = data;
    return { ...rest, orderCount };
  });
}

export async function getStrategyDetails(id: string) {
  const strategy = await Strategy.findByPk(id, {
    include: [
      {
        model: Order,
        as: 'Orders',
        attributes: [
          'id', 'exchangeOrderId', 'exchangeInstanceId', 'symbol', 'side',
          'amount', 'price', 'filledAmount', 'filledPrice', 'status',
          'lifecycleStatus', 'type', 'leverage', 'realizedPnl',
          'initialSl', 'initialTp',
          'closePrice', 'lastPrice', 'createdAt'
        ],
      },
      {
        model: AuditLog,
        as: 'AuditLogs',
        attributes: [
          'id', 'action', 'strategyId', 'orderId', 'routeId',
          'exchangeInstanceId', 'lifecycleStatus', 'details', 'createdAt'
        ],
        order: [['createdAt', 'ASC']],
      },
    ],
  });

  if (!strategy) {
    return null;
  }

  const strategyData = strategy.get({ plain: true });
  const orders = strategyData.Orders || [];
  const auditLogs = strategyData.AuditLogs || [];
  delete strategyData.Orders;
  delete strategyData.AuditLogs;

  return {
    strategy: strategyData,
    orders,
    auditLogs,
  };
}
