import { Op } from 'sequelize';
import { IdempotencyKey } from '../../src/models';
import { IdempotencyService } from '../../src/services/IdempotencyService';

jest.mock('../../src/models', () => ({
  IdempotencyKey: {
    findOne: jest.fn(),
    create: jest.fn(),
    destroy: jest.fn(),
  },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('IdempotencyService', () => {
  const mockedIdempotencyKey = IdempotencyKey as jest.Mocked<typeof IdempotencyKey>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('only treats keys within the 1-minute TTL window as duplicates', async () => {
    mockedIdempotencyKey.findOne.mockResolvedValue({ id: 1 } as any);
    const service = new IdempotencyService();

    const result = await service.checkMessage('channel-1', 'same content');

    expect(result).toEqual({ isDuplicate: true, existingKeyId: 1 });
    expect(mockedIdempotencyKey.findOne).toHaveBeenCalledWith({
      where: {
        channelId: 'channel-1',
        contentHash: expect.any(String),
        firstSeenAt: {
          [Op.gte]: expect.any(Date),
        },
      },
    });
  });

  it('cleans up keys older than 1 minute', async () => {
    mockedIdempotencyKey.destroy.mockResolvedValue(2 as any);
    const service = new IdempotencyService();

    const deleted = await service.cleanupExpiredKeys();

    expect(deleted).toBe(2);
    expect(mockedIdempotencyKey.destroy).toHaveBeenCalledWith({
      where: {
        firstSeenAt: {
          [Op.lt]: expect.any(Date),
        },
      },
    });
  });

  it('starts an internal cleanup loop instead of relying on an external script', async () => {
    jest.useFakeTimers();
    mockedIdempotencyKey.destroy.mockResolvedValue(0 as any);
    const service = new IdempotencyService();

    service.start();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockedIdempotencyKey.destroy).toHaveBeenCalledTimes(2);

    service.stop();
  });
});
