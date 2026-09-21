import routingService from '../../src/services/RoutingService';
import { SignalRoute } from '../../src/models';
import logger from '../../src/utils/logger';

jest.mock('../../src/models', () => ({
  SignalRoute: { findAll: jest.fn() },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/utils/debug', () => ({
  createStageDebug: jest.fn(() => jest.fn()),
}));

describe('RoutingService', () => {
  const mockedFindAll = SignalRoute.findAll as jest.Mock;

  const makeRoute = (overrides: Partial<SignalRoute> = {}): SignalRoute =>
    ({
      id: 1,
      name: 'route',
      channelId: 'ch-1',
      parser: null,
      exchangeInstanceId: 'ex-1',
      ...overrides,
    } as SignalRoute);

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the singleton's route map so tests stay isolated.
    (routingService as any).routes = new Map();
  });

  it('loads active routes and groups them by channel', async () => {
    const routeA = makeRoute({ id: 1, channelId: 'ch-1', name: 'a' });
    const routeB = makeRoute({ id: 2, channelId: 'ch-2', name: 'b' });
    const routeC = makeRoute({ id: 3, channelId: 'ch-1', name: 'c' });
    mockedFindAll.mockResolvedValue([routeA, routeB, routeC]);

    await routingService.initialize();

    expect(mockedFindAll).toHaveBeenCalledWith({ where: { isActive: true } });
    expect(routingService.getRoutes('ch-1')).toEqual([routeA, routeC]);
    expect(routingService.getRoutes('ch-2')).toEqual([routeB]);
    expect(routingService.getRoutes('ch-1')[0]).toBe(routeA);
    expect(logger.info).toHaveBeenCalledWith('RoutingService initialized with 3 routes.');
  });

  it('returns an empty list for channels without routes', async () => {
    mockedFindAll.mockResolvedValue([]);

    await routingService.initialize();

    expect(routingService.getRoutes('unknown-channel')).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('RoutingService initialized with 0 routes.');
  });

  it('swallows initialization errors and logs them', async () => {
    mockedFindAll.mockRejectedValue(new Error('db down'));

    await expect(routingService.initialize()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to initialize RoutingService',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('appends duplicate routes when initialize runs twice without a reload', async () => {
    const route = makeRoute({ id: 1 });
    mockedFindAll.mockResolvedValue([route]);

    await routingService.initialize();
    await routingService.initialize();

    // Current behavior: initialize() does not clear existing routes.
    expect(routingService.getRoutes('ch-1')).toEqual([route, route]);
  });

  it('reloadRoutes replaces the previous route set', async () => {
    const oldRoute = makeRoute({ id: 1, channelId: 'ch-old' });
    const newRoute = makeRoute({ id: 2, channelId: 'ch-new' });
    mockedFindAll.mockResolvedValueOnce([oldRoute]);

    await routingService.initialize();
    mockedFindAll.mockResolvedValueOnce([newRoute]);

    await routingService.reloadRoutes();

    expect(mockedFindAll).toHaveBeenCalledTimes(2);
    expect(routingService.getRoutes('ch-old')).toEqual([]);
    expect(routingService.getRoutes('ch-new')).toEqual([newRoute]);
  });
});
