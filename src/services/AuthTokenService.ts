import jwt, { type SignOptions } from 'jsonwebtoken';
import config from '../config';

export interface AuthTokenUser {
  id: number;
  username: string;
  role: string;
}

export interface AuthTokens {
  token: string;
  refreshToken: string;
}

export interface RefreshTokenPayload extends jwt.JwtPayload {
  id: number;
  username: string;
  role: string;
  type: 'refresh';
  /** 会话绝对截止时间（unix 秒）；undefined 表示不设上限（一直活跃则一直不过期）。 */
  absExp?: number;
}

const EXPIRATION_PATTERN = /^(\d+)([smhd])?$/;

export function getAccessExpiresIn(accessExpiresIn: string | number): string | number {
  if (typeof accessExpiresIn === 'number') {
    if (!Number.isFinite(accessExpiresIn) || accessExpiresIn <= 0) {
      throw new Error('Invalid JWT expiration');
    }
    return accessExpiresIn;
  }

  const trimmed = accessExpiresIn.trim();
  const match = trimmed.match(EXPIRATION_PATTERN);
  if (!match) {
    throw new Error(`Unsupported JWT expiration: ${accessExpiresIn}`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid JWT expiration');
  }

  const unit = match[2];
  if (!unit) {
    return amount;
  }
  return `${amount}${unit}`;
}

/** 将形如 '240h' / '30d' / 3600（秒）的时长归一化为秒数。 */
export function durationToSeconds(duration: string | number): number {
  const normalized = getAccessExpiresIn(duration);
  if (typeof normalized === 'number') {
    return normalized;
  }

  const match = normalized.match(EXPIRATION_PATTERN);
  if (!match) {
    throw new Error(`Unsupported duration: ${duration}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    default:
      return amount;
  }
}

/**
 * Refresh token 有效期（秒）。
 * 优先使用独立的 SERVER_JWT_REFRESH_EXPIRES_IN；未配置时回退为 access 有效期的 10 倍（旧行为）。
 */
export function getRefreshExpiresInSeconds(): number {
  if (config.server.jwtRefreshExpiresIn) {
    return durationToSeconds(config.server.jwtRefreshExpiresIn);
  }
  return durationToSeconds(config.server.jwtExpiresIn) * 10;
}

/**
 * 会话绝对上限（秒）。0 表示不设上限（一直活跃则一直不过期）。
 */
export function getSessionMaxSeconds(): number {
  if (!config.server.jwtSessionMax) {
    return 0;
  }
  return durationToSeconds(config.server.jwtSessionMax);
}

export interface SignAuthTokensOptions {
  /** 刷新时携带原会话的绝对截止时间；登录时不传则按 jwtSessionMax 计算。 */
  absExp?: number;
}

export function signAuthTokens(
  user: AuthTokenUser,
  options: SignAuthTokensOptions = {}
): AuthTokens {
  const now = Math.floor(Date.now() / 1000);
  const payload = { id: user.id, username: user.username, role: user.role };

  const accessTtl = durationToSeconds(config.server.jwtExpiresIn);
  const refreshTtl = getRefreshExpiresInSeconds();
  const sessionMax = getSessionMaxSeconds();

  // 绝对会话截止：刷新时沿用原值（保证“即使一直活跃也需重新登录”的上限），
  // 首次登录从当前时刻开始计算；未配置上限则为 undefined（不限制）。
  const absExp = options.absExp ?? (sessionMax > 0 ? now + sessionMax : undefined);

  const accessExp = absExp !== undefined ? Math.min(now + accessTtl, absExp) : now + accessTtl;
  const refreshExp = absExp !== undefined ? Math.min(now + refreshTtl, absExp) : now + refreshTtl;

  const token = jwt.sign(payload, config.server.jwtSecret, {
    expiresIn: (accessExp - now) as SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign(
    { ...payload, type: 'refresh', absExp },
    config.server.jwtSecret,
    { expiresIn: (refreshExp - now) as SignOptions['expiresIn'] }
  );

  return { token, refreshToken };
}

export function verifyRefreshToken(refreshToken: string): RefreshTokenPayload {
  const decoded = jwt.verify(refreshToken, config.server.jwtSecret) as RefreshTokenPayload;
  if (!decoded || decoded.type !== 'refresh' || typeof decoded.id !== 'number') {
    throw new Error('Invalid refresh token');
  }
  if (decoded.absExp !== undefined && Date.now() / 1000 >= decoded.absExp) {
    throw new Error('Session expired');
  }
  return decoded;
}
