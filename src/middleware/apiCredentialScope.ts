import { Context, Next } from 'koa';
import ApiCredential from '../models/ApiCredential';
import { ApiCredentialScope, parseScopes } from '../services/ApiCredentialService';

const routeScopes: Array<{ prefix: string; scope: ApiCredentialScope }> = [
  { prefix: '/api/orders', scope: 'orders:read' },
  { prefix: '/api/strategies', scope: 'strategies:read' },
  { prefix: '/api/logs', scope: 'logs:read' },
  { prefix: '/api/audit-logs', scope: 'audit:read' },
  { prefix: '/api/exchanges', scope: 'exchanges:read' },
  { prefix: '/api/exchange', scope: 'exchanges:read' },
  { prefix: '/api/positions', scope: 'positions:read' },
];

export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

export function getRequiredReadScope(path: string): ApiCredentialScope | null {
  const match = routeScopes.find(item => path === item.prefix || path.startsWith(`${item.prefix}/`));
  return match?.scope ?? null;
}

export function apiCredentialHasScope(credential: Pick<ApiCredential, 'scopes'>, scope: ApiCredentialScope): boolean {
  return parseScopes(credential.scopes).includes(scope);
}

export const apiCredentialScopeMiddleware = async (ctx: Context, next: Next) => {
  const credential = (ctx.state as any).apiCredential as ApiCredential | undefined;
  if (!credential) {
    await next();
    return;
  }

  if (!isReadMethod(ctx.method)) {
    ctx.status = 403;
    ctx.body = { error: 'API credentials are read-only' };
    return;
  }

  const requiredScope = getRequiredReadScope(ctx.path);
  if (!requiredScope) {
    ctx.status = 403;
    ctx.body = { error: 'API credential access is not allowed for this endpoint' };
    return;
  }

  if (!apiCredentialHasScope(credential, requiredScope)) {
    ctx.status = 403;
    ctx.body = { error: `Missing required scope: ${requiredScope}` };
    return;
  }

  await next();
};
