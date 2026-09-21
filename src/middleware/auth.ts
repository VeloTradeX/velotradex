import { Context, Next } from 'koa';
import jwt from 'jsonwebtoken';
import config from '../config';
import logger from '../utils/logger';
import {
  getApiCredentialTokenPrefix,
  parseScopes,
  verifyApiCredentialToken,
} from '../services/ApiCredentialService';

function extractBearerToken(ctx: Context): string | null {
  const authorization = ctx.headers.authorization;
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

export const authMiddleware = async (ctx: Context, next: Next) => {
  const token = extractBearerToken(ctx);

  if (!token) {
    ctx.status = 401;
    ctx.body = { error: 'Authentication token required' };
    return;
  }

  try {
    const decoded = jwt.verify(token, config.server.jwtSecret);
    ctx.state.user = decoded;
    await next();
    return;
  } catch (jwtError) {
    try {
      const credential = await verifyApiCredentialToken(token);
      if (!credential) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid or expired token' };
        return;
      }

      ctx.state.apiCredential = credential;
      ctx.state.user = {
        id: null,
        username: `api:${credential.name}`,
        role: 'api',
        credentialId: credential.id,
        tokenPrefix: credential.tokenPrefix || getApiCredentialTokenPrefix(token),
        scopes: parseScopes(credential.scopes),
      };
      await next();
    } catch (error) {
      logger.error('request_error', {
        method: ctx.method,
        path: ctx.path,
        error: (error as any)?.message || error,
        tokenPrefix: getApiCredentialTokenPrefix(token),
      });
      ctx.status = 500;
      ctx.body = { error: 'Internal server error' };
    }
  }
};
