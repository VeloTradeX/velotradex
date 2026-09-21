import logger from './utils/logger';
import config from './config';
import { User } from './models';
import redisService from './services/RedisService';
import exchangeRegistry from './services/exchanges';
import routingService from './services/RoutingService';
import tradeExecutor from './services/TradeExecutor';
import idempotencyService from './services/IdempotencyService';
import SoftStopLossMonitor from './services/SoftStopLossMonitor';
import backtestRunManager from './services/backtest/BacktestRunManager';

export async function initializeServices(): Promise<void> {
  // Wait a short grace period for Redis; never blocks API availability.
  // 后台运行，即使 Redis 未就绪也继续初始化其余服务，避免阻塞 HTTP 请求。
  await redisService.waitForReady(5_000);
  logger.info('Redis status: ' + JSON.stringify(redisService.getStatus()));

  logger.info('Database schema is managed by sequelize-cli migrations');

  // Initialize Exchange Instance Manager (Loads exchanges from DB)
  // Note: exchangeRegistry is now the instance manager
  await (exchangeRegistry as any).initialize();
  logger.info('Exchange Instance Manager Initialized');

  // Initialize Routing Service
  await routingService.initialize();
  logger.info('Routing Service Initialized');

  // Initialize Trade Executor (Recover monitors)
  await tradeExecutor.initialize();
  logger.info('Trade Executor Initialized');

  idempotencyService.start();
  logger.info('Idempotency Service Initialized');

  // 回测子进程：软止损监控依赖交易所 K线接口（虚拟交易所返回空），跳过
  if (!config.backtest.child) {
    const softStopLossMonitor = new SoftStopLossMonitor({
      handleClose: (params) => tradeExecutor.closeForSoftStop(params),
    });
    softStopLossMonitor.start();
    logger.info('Soft Stop Loss Monitor Initialized');

    // 主进程：恢复上次服务重启时中断的回测（孤儿子进程标记失败）
    await backtestRunManager.recoverInterruptedRuns();
  }

  // Init Admin User
  const adminUser = await User.findOne({ where: { username: 'admin' } });
  if (!adminUser) {
    const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD || '';
    if (!adminPassword) {
      logger.warn('No ADMIN_DEFAULT_PASSWORD env var set. Skipping default admin creation.');
      logger.warn('Create a user via the API or set ADMIN_DEFAULT_PASSWORD and restart.');
    } else {
      await User.create({ username: 'admin', password: adminPassword, role: 'admin' });
      logger.info('Created default admin user from ADMIN_DEFAULT_PASSWORD env var');
    }
  }

  // Startup summary (composition root wiring note)
  logger.info('Service startup summary', {
    exchangeInstances: exchangeRegistry.getAllExchanges().length,
    tradingMode: config.trading.mode,
    enableTrading: config.enableTrading,
    // Constructor-injection wiring: tradeExecutor uses the process-level
    // exchangeRegistry & builds its own ProtectionContext; routing service
    // and SoftStopLossMonitor are wired to the same tradeExecutor singleton.
    wiring: {
      tradeExecutor: 'process-singleton (default TradeExecutor)',
      protectionContext: 'constructed inside TradeExecutor',
      exchangeRegistry: 'ExchangeInstanceManager singleton (initialized before routes/executor)',
      routingService: 'singleton, init after exchangeRegistry',
      softStopLossMonitor: 'wired to tradeExecutor.closeForSoftStop',
    },
  });
}
