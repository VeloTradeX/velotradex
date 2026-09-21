/**
 * 回测子进程入口（无 HTTP / 不订阅 Redis 消息频道）。
 *
 * 启动方式：主进程 BacktestRunManager 以如下环境变量 spawn：
 *   BACKTEST_CHILD=1                标记回测子进程（禁用实盘 WS 行情源/监控/默认交易所实例）
 *   BACKTEST_RUN_CONFIG=<path>      运行配置文件（含克隆的路由/解析器配置/AI 配置等）
 *   DB_STORAGE=<child.db>           独立 SQLite 数据库（与主库完全隔离）
 *   REDIS_DB=<隔离索引>             独立 Redis DB（幂等键等，与实盘互不干扰）
 *   TRADING_MODE=testnet            使 enableTrading=true，订单真实走虚拟交易所执行
 *
 * 职责：
 * 1. 独立库建表（sequelize.sync）；
 * 2. 注入克隆环境：路由行、解析器配置、AI 配置、图片缓存、bt_ 虚拟 TradFi 交易所实例；
 * 3. 复用 initializeServices 完成服务装配（路由 / 执行器 / 幂等等，与主进程同一套代码）；
 * 4. 运行 BacktestEngine 逐 K 线重放；
 * 5. 写结果文件后退出（主进程负责导入主库）。
 */
import fs from 'fs';
import config from '../config';
import logger from '../utils/logger';
import { sequelize } from '../db';
import { AIConfig, ExchangeInstance, ImageDownloadCache, SignalRoute } from '../models';
import ParserConfig from '../models/ParserConfig';
import { initializeServices } from '../serviceStartup';
import { BacktestEngine, BacktestRunConfig } from './BacktestEngine';

async function main(): Promise<void> {
  const cfgPath = config.backtest.runConfig;
  if (!cfgPath || !fs.existsSync(cfgPath)) {
    throw new Error(`回测运行配置不存在: ${cfgPath || '(未设置 BACKTEST_RUN_CONFIG)'}`);
  }
  if (!config.backtest.child) {
    throw new Error('本入口仅限回测子进程使用（需要 BACKTEST_CHILD=1）');
  }
  const cfg: BacktestRunConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  logger.info(`[BacktestChild] 启动回测子进程: ${cfg.runKey}（运行 #${cfg.runId}）`);

  // ── 1. 独立库建表 ──
  await sequelize.sync();
  logger.info('[BacktestChild] 子进程数据库已就绪');

  // ── 2. 注入克隆环境 ──
  await SignalRoute.create(cfg.route as any);
  for (const parserConfig of cfg.parserConfigs) {
    await ParserConfig.create(parserConfig as any);
  }
  for (const aiConfig of cfg.aiConfigs) {
    await AIConfig.create(aiConfig as any);
  }
  for (const imageCache of cfg.imageCaches) {
    await ImageDownloadCache.upsert(imageCache as any);
  }
  await ExchangeInstance.create({
    id: cfg.runKey,
    type: 'virtual_gate_tradfi',
    name: `回测虚拟交易所 ${cfg.runKey}`,
    config: JSON.stringify({
      initialBalance: cfg.initialBalance,
      maxTickAgeMs: cfg.maxTickAgeMs,
    }),
    status: 'active',
  } as any);
  logger.info(`[BacktestChild] 环境注入完成: 路由#${cfg.route.id} / 解析器配置 ${cfg.parserConfigs.length} 条 / AI 配置 ${cfg.aiConfigs.length} 条 / 图片缓存 ${cfg.imageCaches.length} 条`);

  // ── 3. 服务装配（与主进程同一套初始化，子进程守卫已内建） ──
  await initializeServices();

  // ── 4. 运行回测引擎 ──
  const engine = new BacktestEngine(cfg);

  // 优雅停止：主进程 SIGTERM 后，引擎在当前分钟边界安全收尾并导出部分结果
  const stopHandler = () => {
    logger.info('[BacktestChild] 收到 SIGTERM，请求引擎停止');
    engine.requestStop();
  };
  process.on('SIGTERM', stopHandler);
  process.on('SIGINT', stopHandler);

  await engine.run();

  logger.info('[BacktestChild] 回测子进程正常退出');
  process.exit(0);
}

main().catch(err => {
  logger.error('[BacktestChild] 回测子进程失败', { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) });
  // 进度文件标记失败，主进程据此判错
  try {
    const cfgPath = config.backtest.runConfig;
    if (cfgPath && fs.existsSync(cfgPath)) {
      const cfg: BacktestRunConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      fs.writeFileSync(
        cfg.progressPath,
        JSON.stringify({
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
  } catch {
    /* 尽力而为 */
  }
  process.exit(1);
});
