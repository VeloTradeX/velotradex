import Router from 'koa-router';

const healthRouter = new Router();

/**
 * 健康检查端点（容器 / 负载均衡 / 编排系统使用）。
 *
 * 两条硬性约束，改动前请先看 `docker/README.md` 的「常见问题」：
 * 1. **公开**：必须挂在 `/api/*` 鉴权中间件之前（见 `src/routes/index.ts`）。
 *    历史上健康检查打的是 `/api/version`，该路径被鉴权中间件拦截、恒定返回 401，
 *    导致容器永远 unhealthy。
 * 2. **不依赖数据库 / Redis**：仅表示进程存活，避免把短暂的 DB 抖动放大成
 *    容器反复重启。
 */
healthRouter.get('/healthz', (ctx) => {
  ctx.status = 200;
  ctx.body = { status: 'ok', uptime: process.uptime() };
});

export default healthRouter;
