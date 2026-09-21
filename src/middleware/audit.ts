import { Context, Next } from 'koa';
import ApiAuditLog from '../models/ApiAuditLog';
import config from '../config';
import { safeStringify } from '../utils/json';

export const auditMiddleware = async (ctx: Context, next: Next) => {
  if (!config.server.enableApiAudit) {
    await next();
    return;
  }

  const start = Date.now();
  const { method, path } = ctx.request;
  const getClientIp = () => {
    const forwarded = ctx.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const candidate = forwarded.split(',')[0]?.trim();
      if (candidate) return candidate;
    }
    const realIp = ctx.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim();
    }
    return ctx.request.ip || ctx.ip || '';
  };
  const ip = getClientIp().replace(/^::ffff:/, '');
  
  // Skip audit logs themselves to avoid clutter
  if (path.startsWith('/api/audit-logs')) {
      await next();
      return;
  }

  await next();

  const duration = Date.now() - start;
  const statusCode = ctx.status;

  // Extract user info if authenticated
  const user = (ctx.state as any).user;
  const apiCredential = (ctx.state as any).apiCredential;
  const userId = user && typeof user.id === 'number' ? user.id : null;
  const username = apiCredential
    ? `api:${apiCredential.name}:${apiCredential.tokenPrefix}`
    : user ? user.username : null;

  // Filter sensitive data
  let params: any = {};
  
  if (method === 'GET') {
      params = { ...ctx.query };
  } else {
      params = { ...(ctx.request.body as any) };
  }

  // Redact sensitive fields
  const sensitiveFields = ['password', 'apiSecret', 'apiKey', 'token', 'secret'];
  const redact = (obj: any) => {
      for (const key in obj) {
          if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
              obj[key] = '******';
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
              redact(obj[key]);
          }
      }
  };
  
  // Clone params to avoid modifying original request body
  try {
    const paramsClone = JSON.parse(safeStringify(params));
    redact(paramsClone);
    params = paramsClone;
  } catch (e) {
      params = { error: 'Failed to parse params' };
  }

  try {
    await ApiAuditLog.create({
      userId,
      username,
      method,
      path,
      params: safeStringify(params),
      statusCode,
      ip,
      duration
    });
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
};
