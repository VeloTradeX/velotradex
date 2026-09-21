import { sequelize, LighterClientOrderIndex } from '../../../../src/models';
import { LighterClientOrderIndexStore } from '../../../../src/services/exchanges/lighter/LighterClientOrderIndexStore';
import { UniqueConstraintError } from 'sequelize';

describe('LighterClientOrderIndexStore', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('returns a stable uint48 client order index for the same business key', async () => {
    const store = new LighterClientOrderIndexStore(LighterClientOrderIndex);

    const first = await store.getOrCreate('lighter-main', 'entry:abc');
    const second = await store.getOrCreate('lighter-main', 'entry:abc');

    expect(second).toBe(first);
    expect(BigInt(first)).toBeGreaterThan(0n);
    expect(BigInt(first)).toBeLessThan(2n ** 48n);
  });

  it('retries with the next deterministic candidate when clientOrderIndex collides', async () => {
    const model = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockRejectedValueOnce(new UniqueConstraintError({ errors: [] }))
        .mockResolvedValueOnce({ clientOrderIndex: '222' }),
    };
    const deriveClientOrderIndex = jest.fn().mockReturnValueOnce('111').mockReturnValueOnce('222');
    const store = new LighterClientOrderIndexStore(model, { deriveClientOrderIndex });

    await expect(store.getOrCreate('lighter-main', 'entry:def')).resolves.toBe('222');

    expect(deriveClientOrderIndex).toHaveBeenNthCalledWith(1, 'lighter-main', 'entry:def', 0);
    expect(deriveClientOrderIndex).toHaveBeenNthCalledWith(2, 'lighter-main', 'entry:def', 1);
    expect(model.create).toHaveBeenNthCalledWith(1, {
      exchangeInstanceId: 'lighter-main',
      businessKey: 'entry:def',
      clientOrderIndex: '111',
    });
    expect(model.create).toHaveBeenNthCalledWith(2, {
      exchangeInstanceId: 'lighter-main',
      businessKey: 'entry:def',
      clientOrderIndex: '222',
    });
  });
});
