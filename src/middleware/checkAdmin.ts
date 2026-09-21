import { Next } from 'koa';

export async function checkAdmin(ctx: any, next: Next): Promise<void> {
  const user = ctx.state.user;
  if (!user || user.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Admin access required' };
    return;
  }
  await next();
}
