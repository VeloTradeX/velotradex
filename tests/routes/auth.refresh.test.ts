import jwt from 'jsonwebtoken';
import config from '../../src/config';
import { sequelize, User } from '../../src/models';
import router from '../../src/routes';

jest.mock('../../src/services/RedisService', () => ({
  __esModule: true,
  default: {
    publish: jest.fn(),
    subscribe: jest.fn(),
  },
}));

jest.mock('../../src/services/AIParserService', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/services/WebhookService', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/services/StatsService', () => ({
  __esModule: true,
  default: {
    getStats: jest.fn(),
    incrementTotalMsg: jest.fn(),
    incrementMatchedMsg: jest.fn(),
    incrementParsedStrategy: jest.fn(),
  },
}));

jest.mock('../../src/services/TradingStatsService', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/services/TradeExecutor', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
    getAllExchanges: jest.fn(() => []),
  },
}));

type LoginResponse = {
  token: string;
  refreshToken: string;
  user: {
    username: string;
    role: string;
  };
};

describe('auth refresh routes', () => {
  const originalJwtExpiresIn = config.server.jwtExpiresIn;
  const originalEnableApiAudit = config.server.enableApiAudit;

  beforeAll(() => {
    config.server.enableApiAudit = false;
  });

  beforeEach(async () => {
    config.server.jwtExpiresIn = '1h';
    await sequelize.sync({ force: true });
    await User.create({ username: 'admin', password: 'admin123', role: 'admin' });
  });

  afterAll(async () => {
    config.server.jwtExpiresIn = originalJwtExpiresIn;
    config.server.enableApiAudit = originalEnableApiAudit;
    await sequelize.close();
  });

  async function invokeRoute<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: T }> {
    const ctx: any = {
      method,
      path,
      request: { body, ip: '127.0.0.1' },
      headers,
      query: {},
      state: {},
      matched: [],
      params: {},
      status: 404,
      body: undefined,
      ip: '127.0.0.1',
      set: jest.fn(),
      accepts: () => 'json',
      throw(status: number, message: string) {
        const error: Error & { status?: number } = new Error(message);
        error.status = status;
        throw error;
      },
    };

    await router.routes()(ctx, async () => {
      ctx.status = 404;
      ctx.body = { error: 'Not found' };
    });

    const status =
      ctx.status === 404 &&
      ctx.body !== undefined &&
      !(ctx.body as any)?.error
        ? 200
        : ctx.status;
    return {
      status,
      body: ctx.body as T,
    };
  }

  async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    return invokeRoute<T>('POST', path, body);
  }

  async function login(): Promise<LoginResponse> {
    const response = await postJson<LoginResponse>('/api/auth/login', {
      username: 'admin',
      password: 'admin123',
    });

    expect(response.status).toBe(200);
    return response.body;
  }

  it('login returns access and refresh tokens with independent lifetimes and a session cap', async () => {
    const body = await login();

    expect(body.token).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toEqual({ username: 'admin', role: 'admin' });

    const access = jwt.decode(body.token) as jwt.JwtPayload;
    const refresh = jwt.decode(body.refreshToken) as jwt.JwtPayload;

    expect(refresh.type).toBe('refresh');
    const accessLifetime = (access.exp || 0) - (access.iat || 0);
    const refreshLifetime = (refresh.exp || 0) - (refresh.iat || 0);
    // jwtExpiresIn='1h' + independent jwtRefreshExpiresIn default '240h'
    expect(accessLifetime).toBe(3600);
    expect(refreshLifetime).toBe(864000);
    expect(refresh.absExp).toEqual(expect.any(Number));
  });

  it('refresh accepts a refresh token and returns new tokens', async () => {
    const loginBody = await login();

    const response = await postJson<LoginResponse>('/api/auth/refresh', {
      refreshToken: loginBody.refreshToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.body.user).toEqual({ username: 'admin', role: 'admin' });
  });

  it('refresh carries over the absolute session cap', async () => {
    const now = Math.floor(Date.now() / 1000);
    const absExp = now + 3600;
    const crafted = jwt.sign(
      { id: 1, username: 'admin', role: 'admin', type: 'refresh', absExp },
      config.server.jwtSecret,
      { expiresIn: '1h' }
    );

    const refreshed = await postJson<LoginResponse>('/api/auth/refresh', {
      refreshToken: crafted,
    });

    const newRefresh = jwt.decode(refreshed.body.refreshToken) as jwt.JwtPayload;
    expect(refreshed.status).toBe(200);
    expect(newRefresh.absExp).toBe(absExp);
  });

  it('rejects a refresh token once past the absolute session cap', async () => {
    const now = Math.floor(Date.now() / 1000);

    const pastCap = jwt.sign(
      { id: 1, username: 'admin', role: 'admin', type: 'refresh', absExp: now - 60 },
      config.server.jwtSecret,
      { expiresIn: '1h' }
    );

    const response = await postJson<{ error: string }>('/api/auth/refresh', {
      refreshToken: pastCap,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid or expired refresh token');
  });

  it('refresh rejects an access token', async () => {
    const loginBody = await login();

    const response = await postJson<{ error: string }>('/api/auth/refresh', {
      refreshToken: loginBody.token,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid or expired refresh token');
  });

  it('refreshed access token can access a protected route', async () => {
    const loginBody = await login();
    const refreshed = await postJson<LoginResponse>('/api/auth/refresh', {
      refreshToken: loginBody.refreshToken,
    });

    const protectedResponse = await invokeRoute<any>('GET', '/api/config/trading-mode', undefined, {
      authorization: `Bearer ${refreshed.body.token}`,
    });

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body).toHaveProperty('mode');
  });
});
