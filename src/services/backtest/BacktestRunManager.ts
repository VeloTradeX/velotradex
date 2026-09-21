/**
 * BacktestRunManager —— 主进程回测运行管理器。
 *
 * 职责：
 * 1. createAndStart：校验上传消息 → 生成隔离运行目录（data/backtest/runs/{runKey}/，
 *    含 messages.json / config.json / progress.json / result.json / child.db）
 *    → 克隆路由/解析器配置/AI 配置/图片缓存到运行配置 → 落库 BacktestRun 行
 *    → spawn 回测子进程（BACKTEST_CHILD=1，独立 SQLite + 独立 Redis DB）；
 * 2. 监控：每秒读取子进程写的进度文件并回写 BacktestRun；子进程退出时导入
 *    结果（BacktestImportService）并更新状态/汇总；
 * 3. stopRun：SIGTERM 请求引擎在当前分钟边界安全收尾并导出部分结果，
 *    超时后 SIGKILL 兜底；
 * 4. deleteRun：停止（若在运行）→ 清理主库导入数据 → 删除运行记录与运行目录；
 * 5. recoverInterruptedRuns：主进程重启后，孤儿回测（子进程已不可达）标记失败。
 *
 * 与实盘互不干扰：子进程使用完全独立的数据库与 Redis DB，
 * 主库中的回测数据全部带 backtestRunId / runKey 前缀，默认查询排除。
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { AIConfig, BacktestRun, ExchangeInstance, ImageDownloadCache, SignalRoute } from '../../models';
import ParserConfig from '../../models/ParserConfig';
import config from '../../config';
import logger, { formatError } from '../../utils/logger';
import { normalizeDiscordMessages } from '../../backtest/messageNormalize';
import type { BacktestRunConfig, BacktestProgress } from '../../backtest/BacktestEngine';
import backtestImportService from './BacktestImportService';

export interface CreateRunParams {
  name: string;
  /** 上传的原始消息 JSON 文件（buffer） */
  fileBuffer: Buffer;
  /** 克隆的信号路由 id（解析器/风控/AI 模式取自该路由） */
  routeId: number;
  initialBalance: number;
  /** 用户手动指定的品种提示；空数组则由引擎预解析收集 */
  symbolsHint: string[];
}

interface ManagedRun {
  runId: number;
  runKey: string;
  child: ChildProcess;
  progressPath: string;
  resultPath: string;
  monitorTimer: NodeJS.Timeout;
  /** 子进程退出（含 finalize 完成）后 resolve */
  exited: Promise<void>;
  stopping: boolean;
}

const RUNS_ROOT = path.join(process.cwd(), 'data', 'backtest', 'runs');
/** tick 新鲜度窗口：覆盖 tradfi 周末闭市等长间隙 */
const DEFAULT_MAX_TICK_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** 优雅停止等待：引擎在当前分钟收尾 + 导出结果 */
const GRACEFUL_STOP_MS = 60_000;
const MONITOR_INTERVAL_MS = 1000;

function readJsonSafe(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class BacktestRunManager {
  private readonly runs = new Map<number, ManagedRun>();

  public getRunsRoot(): string {
    return RUNS_ROOT;
  }

  // ─────────────────────────── 创建并启动 ───────────────────────────

  public async createAndStart(params: CreateRunParams): Promise<BacktestRun> {
    // 1. 路由校验
    const route = await SignalRoute.findByPk(params.routeId);
    if (!route) {
      throw new Error(`信号路由 #${params.routeId} 不存在`);
    }

    // 2. 消息规范化预校验
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(params.fileBuffer.toString('utf8'));
    } catch (err: any) {
      throw new Error('消息文件不是合法的 JSON');
    }
    const normalized = normalizeDiscordMessages(rawJson);
    if (normalized.messages.length === 0) {
      throw new Error('导入文件中未找到有效消息（需要 content/attachments 且带 timestamp/channel_id）');
    }

    // 3. 运行目录与 runKey
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const runKey = `bt_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}_${crypto.randomBytes(3).toString('hex')}`;
    const runDir = path.join(RUNS_ROOT, runKey);
    fs.mkdirSync(runDir, { recursive: true });

    const messagesPath = path.join(runDir, 'messages.json');
    const configPath = path.join(runDir, 'config.json');
    const progressPath = path.join(runDir, 'progress.json');
    const resultPath = path.join(runDir, 'result.json');
    const childDbPath = path.join(runDir, 'child.db');
    fs.writeFileSync(messagesPath, params.fileBuffer);

    // 4. 克隆配置（路由的交易所改写为本次回测的虚拟实例 runKey）
    const routePlain: Record<string, any> = route.toJSON();
    routePlain.exchangeInstanceId = runKey;

    const parserConfigs = (await ParserConfig.findAll()).map((row: any) => row.toJSON());
    const aiConfigs = (await AIConfig.findAll({ where: { isActive: true } })).map(row => row.toJSON());

    // 图片缓存：仅克隆本次消息中引用的附件（供视觉解析离线复用）
    const attachmentUrls = Array.from(new Set(
      normalized.messages.flatMap(m => m.attachments.map(a => a.url)).filter(Boolean),
    ));
    const imageCaches: Array<Record<string, any>> = [];
    for (let i = 0; i < attachmentUrls.length; i += 50) {
      const chunk = attachmentUrls.slice(i, i + 50);
      const rows = await ImageDownloadCache.findAll({ where: { url: { [Op.in]: chunk } } });
      imageCaches.push(...rows.map(r => r.toJSON()));
    }

    const initialBalanceStr = String(Number(params.initialBalance) || 1000);

    // 5. 落库运行记录
    const run = await BacktestRun.create({
      runKey,
      name: params.name || `回测 ${runKey}`,
      status: 'preparing',
      messagesPath,
      messageCount: normalized.messages.length,
      rangeStart: new Date(normalized.rangeStart!),
      rangeEnd: new Date(normalized.rangeEnd!),
      parserName: route.parser,
      routeId: route.id,
      config: JSON.stringify({
        routeId: route.id,
        routeName: route.name,
        parserName: route.parser,
        aiMode: route.aiMode,
        initialBalance: Number(initialBalanceStr),
        symbolsHint: params.symbolsHint,
        channels: normalized.channels,
        skippedMessages: normalized.skipped,
        parserConfigCount: parserConfigs.length,
        aiConfigCount: aiConfigs.length,
        imageCacheCount: imageCaches.length,
      }),
      progress: JSON.stringify({ phase: 'preparing', updatedAt: new Date().toISOString() } as BacktestProgress),
    } as any);

    // 6. 写运行配置（子进程入口读取）
    const cfg: BacktestRunConfig = {
      runId: run.id,
      runKey,
      name: run.name,
      messagesPath,
      initialBalance: initialBalanceStr,
      maxTickAgeMs: DEFAULT_MAX_TICK_AGE_MS,
      parserName: route.parser,
      symbolsHint: params.symbolsHint,
      route: routePlain,
      parserConfigs,
      aiConfigs,
      imageCaches,
      childDbPath,
      redisDb: (config.redis.db + 1) % 16,
      progressPath,
      resultPath,
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg));

    // 7. 启动子进程
    try {
      await this.spawnChild(run, cfg, configPath);
    } catch (err) {
      await run.update({ status: 'failed', error: `子进程启动失败: ${err instanceof Error ? err.message : String(err)}` } as any);
      throw err;
    }
    return run;
  }

  private async spawnChild(run: BacktestRun, cfg: BacktestRunConfig, configPath: string): Promise<void> {
    // dev（ts-node 源码运行）与 prod（dist 编译产物）两种入口
    const isTsRuntime = __filename.endsWith('.ts');
    const childModule = path.resolve(__dirname, '../../backtest/child-main' + (isTsRuntime ? '.ts' : '.js'));
    if (!fs.existsSync(childModule)) {
      throw new Error(`回测子进程入口不存在: ${childModule}`);
    }
    const args = isTsRuntime
      ? [require.resolve('ts-node/dist/bin'), '--transpile-only', childModule]
      : [childModule];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BACKTEST_CHILD: '1',
      BACKTEST_RUN_CONFIG: configPath,
      DB_STORAGE: cfg.childDbPath,
      REDIS_DB: String(cfg.redisDb),
      TRADING_MODE: 'testnet',
    };

    const child = spawn(process.execPath, args, {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    logger.info(`[BacktestRunManager] 回测子进程已启动: run=${run.id} key=${cfg.runKey} pid=${child.pid}`);

    let exitResolve: () => void = () => {};
    const exited = new Promise<void>(resolve => { exitResolve = resolve; });

    const managed: ManagedRun = {
      runId: run.id,
      runKey: cfg.runKey,
      child,
      progressPath: cfg.progressPath,
      resultPath: cfg.resultPath,
      monitorTimer: null as any,
      exited,
      stopping: false,
    };
    this.runs.set(run.id, managed);

    // 进度监控：读子进程写的进度文件 → 回写主库
    let lastRaw = '';
    managed.monitorTimer = setInterval(() => {
      void this.pollProgress(run, managed).catch(err => {
        logger.warn('[BacktestRunManager] 进度回写失败', formatError(err));
      });
      // 兜底：防止监控句柄导致进程无法退出（不影响功能）
    }, MONITOR_INTERVAL_MS);
    managed.monitorTimer.unref?.();

    child.on('error', err => {
      logger.error(`[BacktestRunManager] 回测子进程启动错误: run=${run.id}`, formatError(err));
    });

    child.on('exit', async (code, signal) => {
      clearInterval(managed.monitorTimer);
      try {
        await this.finalizeRun(run.id, code, signal);
      } finally {
        exitResolve();
      }
    });

    await run.update({ status: 'running', childPid: child.pid } as any);
  }

  private async pollProgress(run: BacktestRun, managed: ManagedRun): Promise<void> {
    const progress = readJsonSafe(managed.progressPath);
    if (!progress) return;
    const raw = JSON.stringify(progress);
    // 节流：内容无变化不写库
    if (raw === (run as any)._lastProgressRaw) return;
    (run as any)._lastProgressRaw = raw;

    const status = this.phaseToStatus(progress.phase);
    await run.update({ progress: raw, ...(status ? { status } : {}) } as any);
  }

  private phaseToStatus(phase: string | undefined): string | null {
    switch (phase) {
      case 'preparing':
      case 'preParse':
      case 'fetchCandles':
        return 'preparing';
      case 'replaying':
      case 'exporting':
        return 'running';
      default:
        return null; // done/stopped/failed 由 finalize 处理
    }
  }

  /** 子进程退出后收尾：导入结果 / 标记失败 */
  private async finalizeRun(runId: number, code: number | null, signal: string | null): Promise<void> {
    const managed = this.runs.get(runId);
    this.runs.delete(runId);
    const run = await BacktestRun.findByPk(runId);
    if (!run) return;

    try {
      const resultPath = managed?.resultPath || path.join(path.dirname(run.messagesPath), 'result.json');
      if (fs.existsSync(resultPath)) {
        const { result, summary } = await backtestImportService.importFromFile(resultPath, run.id, run.runKey);
        const progress = readJsonSafe(managed?.progressPath || '') || {};
        await run.update({
          status: result.stopped ? 'stopped' : 'completed',
          summary: JSON.stringify(summary),
          progress: JSON.stringify(progress),
          error: null,
        } as any);
        logger.info(`[BacktestRunManager] 回测 #${run.id} 完成: status=${result.stopped ? 'stopped' : 'completed'}`);
      } else {
        const progress = readJsonSafe(managed?.progressPath || '');
        const error = progress?.phase === 'failed' && progress?.error
          ? String(progress.error)
          : `回测子进程异常退出 (code=${code}, signal=${signal})`;
        await run.update({ status: 'failed', error } as any);
        logger.error(`[BacktestRunManager] 回测 #${run.id} 失败: ${error}`);
      }
    } catch (err) {
      logger.error(`[BacktestRunManager] 回测 #${run.id} 结果导入失败`, formatError(err));
      await run.update({ status: 'failed', error: `结果导入失败: ${err instanceof Error ? err.message : String(err)}` } as any);
    }
  }

  // ─────────────────────────── 停止 / 删除 ───────────────────────────

  /** 请求停止：SIGTERM 让引擎安全收尾；超时 SIGKILL；等待子进程完全退出 */
  public async stopRun(runId: number): Promise<void> {
    const managed = this.runs.get(runId);
    if (!managed) {
      throw new Error('该回测未在运行（可能已完成或已失败）');
    }
    if (managed.stopping) {
      await managed.exited;
      return;
    }
    managed.stopping = true;
    logger.info(`[BacktestRunManager] 请求停止回测 #${runId}（SIGTERM）`);
    try {
      managed.child.kill('SIGTERM');
    } catch (err) {
      logger.warn('[BacktestRunManager] SIGTERM 发送失败', formatError(err));
    }

    // 优雅等待
    const graceful = await Promise.race([
      managed.exited.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), GRACEFUL_STOP_MS)),
    ]);
    if (!graceful && !managed.child.killed) {
      logger.warn(`[BacktestRunManager] 回测 #${runId} 优雅停止超时，强制结束（SIGKILL）`);
      try {
        managed.child.kill('SIGKILL');
      } catch { /* 已退出 */ }
      await Promise.race([
        managed.exited,
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);
    }
  }

  /** 删除回测：停止（若在运行）→ 清理主库数据 → 删除记录与运行目录 */
  public async deleteRun(runId: number): Promise<void> {
    const run = await BacktestRun.findByPk(runId);
    if (!run) {
      throw new Error(`回测 #${runId} 不存在`);
    }

    if (this.runs.has(runId)) {
      await this.stopRun(runId);
    }

    await backtestImportService.deleteRunData(runId, run.runKey);
    await ExchangeInstance.destroy({ where: { id: run.runKey } });
    await run.destroy();

    const runDir = path.dirname(run.messagesPath);
    if (runDir.startsWith(RUNS_ROOT)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    logger.info(`[BacktestRunManager] 回测 #${runId} 已删除（含数据与文件）`);
  }

  // ─────────────────────────── 启动恢复 ───────────────────────────

  /**
   * 主进程重启后：上次仍在 running/preparing 的回测子进程已成孤儿
   * （无法重新附着监控），直接终止其 PID 并标记失败，避免悬挂。
   */
  public async recoverInterruptedRuns(): Promise<void> {
    try {
      const interrupted = await BacktestRun.findAll({ where: { status: ['running', 'preparing', 'pending'] } });
      for (const run of interrupted) {
        if (run.childPid) {
          try {
            process.kill(run.childPid, 0);
            process.kill(run.childPid, 'SIGKILL');
            logger.warn(`[BacktestRunManager] 已终止孤儿回测子进程 pid=${run.childPid} (run=${run.id})`);
          } catch {
            // 进程已不存在
          }
        }
        await run.update({ status: 'failed', error: '服务重启导致回测中断' } as any);
      }
      if (interrupted.length > 0) {
        logger.warn(`[BacktestRunManager] 启动恢复：${interrupted.length} 个中断回测已标记失败`);
      }
    } catch (err) {
      logger.error('[BacktestRunManager] 启动恢复失败', formatError(err));
    }
  }
}

export default new BacktestRunManager();
