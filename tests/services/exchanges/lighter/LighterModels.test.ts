import { UniqueConstraintError, ValidationError } from 'sequelize';
import { sequelize, LighterTxJournal, LighterClientOrderIndex } from '../../../../src/models';

describe('Lighter persistence models', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('persists transaction lifecycle fields', async () => {
    await LighterTxJournal.create({
      txId: 'tx-001',
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      nonce: '123456789',
      txType: 14,
      txInfoHash: 'hash-001',
      intentJson: JSON.stringify({ action: 'create-order', marketId: 1 }),
      status: 'SIGNED',
      strategyId: 42,
      orderId: 99,
      clientOrderIndex: 'client-001',
      error: 'temporary retry state',
      confirmedAt: new Date('2026-05-05T08:00:00.000Z'),
    });

    const persisted = await LighterTxJournal.findByPk('tx-001');

    expect(persisted).toMatchObject({
      txId: 'tx-001',
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      nonce: '123456789',
      txType: 14,
      txInfoHash: 'hash-001',
      intentJson: JSON.stringify({ action: 'create-order', marketId: 1 }),
      status: 'SIGNED',
      strategyId: 42,
      orderId: 99,
      clientOrderIndex: 'client-001',
      error: 'temporary retry state',
    });
    expect(persisted?.confirmedAt?.toISOString()).toBe('2026-05-05T08:00:00.000Z');
    expect(persisted?.createdAt).toBeInstanceOf(Date);
    expect(persisted?.updatedAt).toBeInstanceOf(Date);
  });

  it('defaults transaction status to CREATED', async () => {
    const tx = await LighterTxJournal.create({
      txId: 'tx-default-status',
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      nonce: '123456790',
      txType: 14,
      txInfoHash: 'hash-002',
      intentJson: '{}',
    });

    expect(tx.status).toBe('CREATED');
  });

  it('rejects invalid transaction status values', async () => {
    await expect(
      LighterTxJournal.create({
        txId: 'tx-invalid-status',
        exchangeInstanceId: 'lighter-main',
        accountIndex: 7,
        apiKeyIndex: 2,
        nonce: '123456791',
        txType: 14,
        txInfoHash: 'hash-003',
        intentJson: '{}',
        status: 'BAD',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces idempotent business key mapping', async () => {
    await LighterClientOrderIndex.create({
      exchangeInstanceId: 'lighter-main',
      businessKey: 'strategy-42:entry:BTC',
      clientOrderIndex: 'client-001',
    });

    await expect(
      LighterClientOrderIndex.create({
        exchangeInstanceId: 'lighter-main',
        businessKey: 'strategy-42:entry:BTC',
        clientOrderIndex: 'client-002',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    await expect(
      LighterClientOrderIndex.create({
        exchangeInstanceId: 'lighter-main',
        businessKey: 'strategy-43:entry:BTC',
        clientOrderIndex: 'client-001',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    await expect(
      LighterClientOrderIndex.create({
        exchangeInstanceId: 'lighter-secondary',
        businessKey: 'strategy-42:entry:BTC',
        clientOrderIndex: 'client-001',
      }),
    ).resolves.toMatchObject({
      exchangeInstanceId: 'lighter-secondary',
      businessKey: 'strategy-42:entry:BTC',
      clientOrderIndex: 'client-001',
    });
  });
});
