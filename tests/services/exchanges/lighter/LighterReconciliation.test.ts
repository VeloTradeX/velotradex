import { Op } from 'sequelize';
import { LighterStateReconciler } from '../../../../src/services/exchanges/lighter/LighterStateReconciler';

describe('Lighter startup reconciliation', () => {
  it('pauses trading when UNKNOWN tx journals exist for the exchange instance', async () => {
    const journalModel = {
      findAll: jest.fn().mockResolvedValue([
        { txId: 'tx-unknown', status: 'UNKNOWN', exchangeInstanceId: 'lighter-main' },
      ]),
    };
    const reconciler = new LighterStateReconciler({ journalModel });

    await expect(reconciler.reconcileStartup('lighter-main')).resolves.toEqual({
      safeToTrade: false,
      unknownTxCount: 1,
    });

    expect(journalModel.findAll).toHaveBeenCalledWith({
      where: {
        exchangeInstanceId: 'lighter-main',
        status: { [Op.in]: ['UNKNOWN', 'SENT', 'ACCEPTED'] },
      },
    });
  });

  it.each(['SENT', 'ACCEPTED'])('pauses trading when %s tx journals exist for the exchange instance', async status => {
    const journalModel = {
      findAll: jest.fn().mockResolvedValue([
        { txId: `tx-${status.toLowerCase()}`, status, exchangeInstanceId: 'lighter-main' },
      ]),
    };
    const reconciler = new LighterStateReconciler({ journalModel });

    await expect(reconciler.reconcileStartup('lighter-main')).resolves.toEqual({
      safeToTrade: false,
      unknownTxCount: 1,
    });
  });

  it('marks accepted journal safe when remote tx is confirmed', async () => {
    const row: any = {
      txId: 'tx-1',
      nonce: '42',
      status: 'ACCEPTED',
      save: jest.fn(async () => undefined),
    };
    const journalModel = { findAll: jest.fn(async () => [row]) };
    const lookupTx = jest.fn(async () => ({ status: 'confirmed' }));
    const reconciler = new LighterStateReconciler({ journalModel, lookupTx } as any);

    await expect(reconciler.reconcileStartup('lighter-main')).resolves.toEqual({
      safeToTrade: true,
      unknownTxCount: 0,
    });
    expect(row.status).toBe('CONFIRMED');
  });

  it('marks accepted journal rejected when remote tx is rejected', async () => {
    const row: any = {
      txId: 'tx-1',
      nonce: '42',
      status: 'ACCEPTED',
      save: jest.fn(async () => undefined),
    };
    const journalModel = { findAll: jest.fn(async () => [row]) };
    const lookupTx = jest.fn(async () => ({ status: 'rejected', error: 'sequencer rejected' }));
    const reconciler = new LighterStateReconciler({ journalModel, lookupTx } as any);

    await expect(reconciler.reconcileStartup('lighter-main')).resolves.toEqual({
      safeToTrade: true,
      unknownTxCount: 0,
    });
    expect(row.status).toBe('REJECTED');
  });

  it('repairs legacy unsigned UNKNOWN rows as rejected local failures', async () => {
    const row: any = {
      txId: 'tx-local-failure',
      nonce: '2',
      txInfoHash: '',
      status: 'UNKNOWN',
      error: 'unsupported signer action: set_leverage',
      save: jest.fn(async () => undefined),
    };
    const journalModel = { findAll: jest.fn(async () => [row]) };
    const reconciler = new LighterStateReconciler({ journalModel } as any);

    await expect(reconciler.reconcileStartup('lighter-main')).resolves.toEqual({
      safeToTrade: true,
      unknownTxCount: 0,
    });

    expect(row.status).toBe('REJECTED');
    expect(row.error).toBe('unsupported signer action: set_leverage');
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(row.save).toHaveBeenCalledTimes(1);
  });
});
