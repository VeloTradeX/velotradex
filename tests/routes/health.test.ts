import healthRouter from '../../src/routes/health';

/**
 * /healthz 是容器健康检查端点。
 *
 * 历史回归：健康检查曾使用 /api/version，而该路径被 `/api/*` 鉴权中间件拦截并
 * 恒定返回 401，导致 Docker 容器永远 unhealthy。
 *
 * 这里只验证 handler 本身（公开、200、不依赖数据库）。注册顺序由
 * `src/routes/index.ts` 保证（在 `/api/*` 中间件之前），并已由真实容器
 * `curl http://localhost:3000/healthz` 校验。
 */
describe('GET /healthz', () => {
  const layer: any = (healthRouter as any).stack.find((l: any) => l.path === '/healthz');

  it('registers the route', () => {
    expect(layer).toBeDefined();
    expect(layer.methods).toEqual(expect.arrayContaining(['GET', 'HEAD']));
  });

  it('returns 200 without requiring an auth token', async () => {
    const ctx: any = { status: 404, headers: {}, path: '/healthz' };

    await layer.stack[0](ctx, async () => {
      throw new Error('health handler should not call next()');
    });

    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({ status: 'ok' });
    expect(typeof ctx.body.uptime).toBe('number');
  });
});
