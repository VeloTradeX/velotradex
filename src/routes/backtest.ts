/**
 * 回测 API（仅主进程使用）。
 *
 * 端点：
 * - GET    /runs                 列出回测（含进度/汇总，JSON 已解析）
 * - POST   /runs                 创建并启动（multipart：file=消息 JSON，
 *                                name/routeId/initialBalance/symbolsHint）
 * - GET    /runs/:id             单个回测详情
 * - POST   /runs/:id/stop        请求停止（引擎在当前分钟收尾并导出部分结果）
 * - DELETE /runs/:id             删除（停止运行 + 清理导入数据 + 删除运行目录）
 * - GET    /runs/:id/result      读取隔离结果 result.json（?section= 可只取部分）
 * - POST   /runs/:id/reimport    重新导入结果到主库（导入失败后重试）
 *
 * 全部走全局 auth 中间件；创建/停止/删除/重导为写操作，返回语义化错误。
 */
import Router from 'koa-router';
import multer from '@koa/multer';
import fs from 'fs';
import path from 'path';
import { BacktestRun } from '../models';
import backtestRunManager from '../services/backtest/BacktestRunManager';
import backtestImportService from '../services/backtest/BacktestImportService';
import logger, { formatError } from '../utils/logger';

const router = new Router();
/** 消息文件上限：预处理后的历史消息（含图片 URL）一般 < 50MB */
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

class BacktestRouteError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const parseJsonField = (value: unknown): any | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** 行 → API 响应（config/progress/summary 解析为对象，便于前端直接使用） */
const serializeRun = (run: BacktestRun) => {
  const data = run.get({ plain: true }) as any;
  return {
    id: data.id,
    runKey: data.runKey,
    name: data.name,
    status: data.status,
    messageCount: data.messageCount,
    rangeStart: data.rangeStart,
    rangeEnd: data.rangeEnd,
    parserName: data.parserName,
    routeId: data.routeId,
    config: parseJsonField(data.config),
    progress: parseJsonField(data.progress),
    summary: parseJsonField(data.summary),
    error: data.error,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
};

const findRunOrThrow = async (id: string): Promise<BacktestRun> => {
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new BacktestRouteError(400, '无效的回测 id');
  }
  const run = await BacktestRun.findByPk(runId);
  if (!run) {
    throw new BacktestRouteError(404, `回测 #${runId} 不存在`);
  }
  return run;
};

/** 运行目录 = messagesPath 所在目录；防止任意文件读取 */
const runFile = (run: BacktestRun, filename: string): string => {
  const dir = path.dirname(run.messagesPath);
  const file = path.join(dir, filename);
  if (!file.startsWith(backtestRunManager.getRunsRoot())) {
    throw new BacktestRouteError(400, '非法的文件路径');
  }
  return file;
};

// ─────────────────────────── 列表 / 详情 ───────────────────────────

router.get('/runs', async (ctx) => {
  try {
    const runs = await BacktestRun.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
    ctx.body = runs.map(serializeRun);
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

router.get('/runs/:id', async (ctx) => {
  try {
    const run = await findRunOrThrow(ctx.params.id);
    ctx.body = serializeRun(run);
  } catch (error: any) {
    ctx.status = error instanceof BacktestRouteError ? error.status : 500;
    ctx.body = { error: error.message };
  }
});

// ─────────────────────────── 创建并启动 ───────────────────────────

router.post('/runs', async (ctx) => {
  try {
    await upload.single('file')(ctx as any, async () => {});
  } catch (error: any) {
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      ctx.status = 413;
      ctx.body = { error: '文件过大，最大允许 50MB' };
      return;
    }
    ctx.status = 500;
    ctx.body = { error: error.message };
    return;
  }

  const file = (ctx as any).file;
  if (!file || !file.buffer?.length) {
    ctx.status = 400;
    ctx.body = { error: '请上传消息 JSON 文件（字段名 file）' };
    return;
  }

  const body = (ctx.request as any).body || {};
  const routeId = Number(body.routeId);
  if (!Number.isInteger(routeId) || routeId <= 0) {
    ctx.status = 400;
    ctx.body = { error: 'routeId 必须是有效的信号路由 id' };
    return;
  }

  const initialBalance = Number(body.initialBalance);
  if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
    ctx.status = 400;
    ctx.body = { error: 'initialBalance 必须是正数（默认 1000）' };
    return;
  }

  // symbolsHint：逗号分隔或 JSON 数组
  let symbolsHint: string[] = [];
  const rawHint = body.symbolsHint;
  if (typeof rawHint === 'string' && rawHint.trim()) {
    if (rawHint.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(rawHint);
        if (Array.isArray(parsed)) symbolsHint = parsed.map(String);
      } catch { /* 忽略非法 JSON */ }
    }
    if (symbolsHint.length === 0) {
      symbolsHint = rawHint.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    }
  } else if (Array.isArray(rawHint)) {
    symbolsHint = rawHint.map(String).filter(Boolean);
  }

  try {
    const run = await backtestRunManager.createAndStart({
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '',
      fileBuffer: file.buffer,
      routeId,
      initialBalance,
      symbolsHint,
    });
    ctx.status = 201;
    ctx.body = serializeRun(run);
  } catch (error: any) {
    logger.error('[backtest-routes] 创建回测失败', formatError(error));
    ctx.status = 400;
    ctx.body = { error: error.message };
  }
});

// ─────────────────────────── 停止 / 删除 ───────────────────────────

router.post('/runs/:id/stop', async (ctx) => {
  try {
    const run = await findRunOrThrow(ctx.params.id);
    if (!['running', 'preparing'].includes(run.status)) {
      ctx.status = 409;
      ctx.body = { error: `回测当前状态为 ${run.status}，无需停止` };
      return;
    }
    await backtestRunManager.stopRun(run.id);
    const fresh = await BacktestRun.findByPk(run.id);
    ctx.body = serializeRun(fresh || run);
  } catch (error: any) {
    ctx.status = error instanceof BacktestRouteError ? error.status : 500;
    ctx.body = { error: error.message };
  }
});

router.delete('/runs/:id', async (ctx) => {
  try {
    const run = await findRunOrThrow(ctx.params.id);
    await backtestRunManager.deleteRun(run.id);
    ctx.body = { success: true };
  } catch (error: any) {
    ctx.status = error instanceof BacktestRouteError ? error.status : 500;
    ctx.body = { error: error.message };
  }
});

// ─────────────────────────── 结果 / 重导入 ───────────────────────────

/**
 * 读取隔离结果文件。?section=strategies|orders|virtualOrders|virtualTrades|
 * virtualPositions|virtualAccounts|auditLogs|aiLogs|strategyPositions|
 * softStopLosses|summary 只返回对应部分，避免整包过大。
 */
router.get('/runs/:id/result', async (ctx) => {
  try {
    const run = await findRunOrThrow(ctx.params.id);
    const resultPath = runFile(run, 'result.json');
    if (!fs.existsSync(resultPath)) {
      ctx.status = 404;
      ctx.body = { error: '回测结果尚未生成（可能仍在运行或已失败）' };
      return;
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const section = ctx.query.section as string | undefined;
    if (section && section !== 'all') {
      if (!(section in result)) {
        ctx.status = 400;
        ctx.body = { error: `未知的结果段落: ${section}` };
        return;
      }
      ctx.body = { section, data: result[section] };
      return;
    }
    ctx.body = result;
  } catch (error: any) {
    ctx.status = error instanceof BacktestRouteError ? error.status : 500;
    ctx.body = { error: error.message };
  }
});

router.post('/runs/:id/reimport', async (ctx) => {
  try {
    const run = await findRunOrThrow(ctx.params.id);
    const resultPath = runFile(run, 'result.json');
    if (!fs.existsSync(resultPath)) {
      ctx.status = 404;
      ctx.body = { error: '回测结果文件不存在，无法重导' };
      return;
    }
    const { summary } = await backtestImportService.importFromFile(resultPath, run.id, run.runKey);
    await run.update({ summary: JSON.stringify(summary) } as any);
    ctx.body = { success: true, summary };
  } catch (error: any) {
    logger.error('[backtest-routes] 重导回测结果失败', formatError(error));
    ctx.status = error instanceof BacktestRouteError ? error.status : 500;
    ctx.body = { error: error.message };
  }
});

export default router;
