import jwt from 'jsonwebtoken';
import config from '../../src/config';
import {
  durationToSeconds,
  getRefreshExpiresInSeconds,
  getSessionMaxSeconds,
  signAuthTokens,
  verifyRefreshToken,
} from '../../src/services/AuthTokenService';

describe('AuthTokenService', () => {
  const originalJwtExpiresIn = config.server.jwtExpiresIn;
  const originalJwtRefreshExpiresIn = config.server.jwtRefreshExpiresIn;
  const originalJwtSessionMax = config.server.jwtSessionMax;

  afterEach(() => {
    config.server.jwtExpiresIn = originalJwtExpiresIn;
    config.server.jwtRefreshExpiresIn = originalJwtRefreshExpiresIn;
    config.server.jwtSessionMax = originalJwtSessionMax;
  });

  it('parses durations into seconds', () => {
    expect(durationToSeconds('30s')).toBe(30);
    expect(durationToSeconds('60m')).toBe(3600);
    expect(durationToSeconds('24h')).toBe(86400);
    expect(durationToSeconds('30d')).toBe(2592000);
    expect(durationToSeconds(3600)).toBe(3600);
    expect(durationToSeconds('3600')).toBe(3600);
  });

  it('uses the independent refresh TTL when configured', () => {
    config.server.jwtRefreshExpiresIn = '240h';
    expect(getRefreshExpiresInSeconds()).toBe(864000);
  });

  it('falls back to 10x access TTL when refresh TTL is not configured', () => {
    config.server.jwtRefreshExpiresIn = '';
    config.server.jwtExpiresIn = '1h';
    expect(getRefreshExpiresInSeconds()).toBe(36000);
  });

  it('returns 0 session max when not configured and seconds when configured', () => {
    config.server.jwtSessionMax = '';
    expect(getSessionMaxSeconds()).toBe(0);
    config.server.jwtSessionMax = '30d';
    expect(getSessionMaxSeconds()).toBe(2592000);
  });

  it('signs tokens with independent refresh TTL and absolute cap claim', () => {
    config.server.jwtExpiresIn = '1h';
    config.server.jwtRefreshExpiresIn = '240h';
    config.server.jwtSessionMax = '30d';

    const tokens = signAuthTokens({ id: 1, username: 'admin', role: 'admin' });
    const access = jwt.decode(tokens.token) as jwt.JwtPayload;
    const refresh = jwt.decode(tokens.refreshToken) as jwt.JwtPayload;

    expect(refresh.type).toBe('refresh');
    expect((access.exp || 0) - (access.iat || 0)).toBe(3600);
    expect((refresh.exp || 0) - (refresh.iat || 0)).toBe(864000);
    expect(refresh.absExp).toBe((refresh.iat || 0) + 30 * 86400);
  });

  it('caps access and refresh expiry at the absolute session max', () => {
    config.server.jwtExpiresIn = '24h';
    config.server.jwtRefreshExpiresIn = '240h';
    config.server.jwtSessionMax = '2h';

    const tokens = signAuthTokens({ id: 1, username: 'admin', role: 'admin' });
    const access = jwt.decode(tokens.token) as jwt.JwtPayload;
    const refresh = jwt.decode(tokens.refreshToken) as jwt.JwtPayload;

    expect((access.exp || 0) - (access.iat || 0)).toBe(2 * 3600);
    expect((refresh.exp || 0) - (refresh.iat || 0)).toBe(2 * 3600);
    expect(refresh.absExp).toBe((refresh.iat || 0) + 2 * 3600);
  });

  it('carries over the absolute cap on refresh', () => {
    config.server.jwtSessionMax = '30d';
    const first = signAuthTokens({ id: 1, username: 'admin', role: 'admin' });
    const firstRefresh = jwt.decode(first.refreshToken) as jwt.JwtPayload;

    const second = signAuthTokens(
      { id: 1, username: 'admin', role: 'admin' },
      { absExp: firstRefresh.absExp }
    );
    const secondRefresh = jwt.decode(second.refreshToken) as jwt.JwtPayload;
    expect(secondRefresh.absExp).toBe(firstRefresh.absExp);
  });

  it('rejects refresh tokens past the absolute cap', () => {
    const tokens = signAuthTokens({ id: 1, username: 'admin', role: 'admin' });
    const now = Math.floor(Date.now() / 1000);

    // forge a refresh token whose absolute cap is already in the past
    const expired = jwt.sign(
      { id: 1, username: 'admin', role: 'admin', type: 'refresh', absExp: now - 100 },
      config.server.jwtSecret,
      { expiresIn: '1h' }
    );
    expect(() => verifyRefreshToken(expired)).toThrow('Session expired');
  });

  it('rejects access tokens when verifying refresh tokens', () => {
    const tokens = signAuthTokens({ id: 1, username: 'admin', role: 'admin' });
    expect(() => verifyRefreshToken(tokens.token)).toThrow('Invalid refresh token');
  });
});
