import { LighterNonceManager } from '../../../../src/services/exchanges/lighter/LighterNonceManager';
import { LighterTxIntent } from '../../../../src/services/exchanges/lighter/types';

type JournalRecord = Record<string, unknown> & {
  txId: string;
  nonce: string;
  status: string;
  statusHistory: string[];
  save: jest.Mock<Promise<void>, []>;
};

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not met');
};

const makeJournalModel = (journalRows: JournalRecord[]) => ({
  create: jest.fn(async (row: Record<string, unknown>) => {
    const record = {
      ...row,
      statusHistory: [row.status as string],
      save: jest.fn(async function save(this: JournalRecord) {
        this.statusHistory.push(this.status);
      }),
    } as JournalRecord;
    journalRows.push(record);
    return record;
  }),
});

describe('LighterNonceManager', () => {
  it('serializes concurrent submissions, uses nextNonce then sequential nonces, and persists SENT before ACCEPTED', async () => {
    const journalRows: JournalRecord[] = [];
    const journalModel = makeJournalModel(journalRows);
    const signer = {
      sign: jest.fn(async (intent: LighterTxIntent & { nonce: string }) => ({
        txType: 14,
        txInfo: `0x${intent.nonce}`,
        txInfoHash: `hash-${intent.nonce}`,
      })),
    };
    const firstSend = createDeferred<{ accepted: boolean; raw: unknown; txHash: string }>();
    const restClient = {
      getNextNonce: jest.fn().mockResolvedValue('100'),
      sendTx: jest
        .fn()
        .mockReturnValueOnce(firstSend.promise)
        .mockResolvedValueOnce({ accepted: true, raw: { code: 200, tx_hash: 'tx-hash-101' }, txHash: 'tx-hash-101' }),
    };
    const manager = new LighterNonceManager({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      signer,
      restClient,
      journalModel,
    });

    const first = manager.submit({
      action: 'create-order',
      symbol: 'BTC-USDC',
      strategyId: 42,
      orderId: 99,
      clientOrderIndex: 'client-001',
    } as LighterTxIntent & { strategyId: number; orderId: number });
    const second = manager.submit({
      action: 'cancel-order',
      orderId: 'exchange-order-2',
      clientOrderIndex: 'client-002',
    });

    await waitFor(() => restClient.sendTx.mock.calls.length === 1);

    expect(restClient.getNextNonce).toHaveBeenCalledTimes(1);
    expect(restClient.getNextNonce).toHaveBeenCalledWith(7, 2);
    expect(restClient.sendTx).toHaveBeenCalledTimes(1);
    expect(manager.getQueueLength()).toBe(2);

    firstSend.resolve({ accepted: true, raw: { code: 200, tx_hash: 'tx-hash-100' }, txHash: 'tx-hash-100' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ txType: 14, txInfoHash: 'hash-100', nonce: '100', raw: { code: 200, tx_hash: 'tx-hash-100' } }),
      expect.objectContaining({ txType: 14, txInfoHash: 'hash-101', nonce: '101', raw: { code: 200, tx_hash: 'tx-hash-101' } }),
    ]);

    expect(restClient.sendTx).toHaveBeenCalledTimes(2);
    expect(restClient.sendTx).toHaveBeenNthCalledWith(1, 14, '0x100');
    expect(restClient.sendTx).toHaveBeenNthCalledWith(2, 14, '0x101');
    expect(journalRows).toHaveLength(2);
    expect(journalRows[0]).toMatchObject({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      nonce: '100',
      txType: 14,
      txInfoHash: 'hash-100',
      strategyId: 42,
      orderId: 99,
      clientOrderIndex: 'client-001',
      status: 'ACCEPTED',
    });
    expect(journalRows[1]).toMatchObject({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      nonce: '101',
      txType: 14,
      txInfoHash: 'hash-101',
      clientOrderIndex: 'client-002',
      status: 'ACCEPTED',
    });
    expect(journalRows[0].statusHistory).toEqual(['CREATED', 'SIGNED', 'SENT', 'ACCEPTED']);
    expect(journalRows[1].statusHistory).toEqual(['CREATED', 'SIGNED', 'SENT', 'ACCEPTED']);
    expect(JSON.parse(journalRows[0].intentJson as string)).toMatchObject({
      action: 'create-order',
      clientOrderIndex: 'client-001',
    });
    expect(signer.sign).toHaveBeenNthCalledWith(1, expect.objectContaining({ nonce: '100' }));
    expect(signer.sign).toHaveBeenNthCalledWith(2, expect.objectContaining({ nonce: '101' }));
    expect(manager.getQueueLength()).toBe(0);
  });

  it('marks rejected when sendTx returns accepted false', async () => {
    const journalRows: JournalRecord[] = [];
    const signer = {
      sign: jest.fn(async () => ({ txType: 14, txInfo: '0x100', txInfoHash: 'hash-100' })),
    };
    const restClient = {
      getNextNonce: jest.fn().mockResolvedValue('100'),
      sendTx: jest.fn().mockResolvedValue({ accepted: false, raw: { code: 400, message: 'bad order' }, error: 'bad order' }),
    };
    const manager = new LighterNonceManager({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      signer,
      restClient,
      journalModel: makeJournalModel(journalRows),
    });

    await expect(manager.submit({ action: 'create-order' })).resolves.toEqual(
      expect.objectContaining({ nonce: '100', raw: { code: 400, message: 'bad order' } }),
    );

    expect(journalRows[0].status).toBe('REJECTED');
    expect(journalRows[0].error).toBe('bad order');
    expect(journalRows[0].statusHistory).toEqual(['CREATED', 'SIGNED', 'SENT', 'REJECTED']);
  });

  it('keeps rejected final when nonce refresh fails after accepted false nonce rejection', async () => {
    const journalRows: JournalRecord[] = [];
    const signer = {
      sign: jest.fn(async () => ({ txType: 14, txInfo: '0x100', txInfoHash: 'hash-100' })),
    };
    const restClient = {
      getNextNonce: jest.fn().mockResolvedValueOnce('100').mockRejectedValueOnce(new Error('nonce endpoint down')),
      sendTx: jest.fn().mockResolvedValue({
        accepted: false,
        raw: { code: 400, message: 'invalid nonce' },
        error: 'invalid nonce',
      }),
    };
    const manager = new LighterNonceManager({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      signer,
      restClient,
      journalModel: makeJournalModel(journalRows),
    });

    await expect(manager.submit({ action: 'create-order' })).resolves.toEqual(
      expect.objectContaining({
        nonce: '100',
        raw: { code: 400, message: 'invalid nonce' },
        error: 'invalid nonce',
      }),
    );

    expect(restClient.getNextNonce).toHaveBeenCalledTimes(2);
    expect(journalRows[0].status).toBe('REJECTED');
    expect(journalRows[0].error).toBe('invalid nonce');
    expect(journalRows[0].statusHistory).toEqual(['CREATED', 'SIGNED', 'SENT', 'REJECTED']);
  });

  it('marks unknown, refreshes nonce on nonce errors, and rethrows when sendTx throws', async () => {
    const journalRows: JournalRecord[] = [];
    const signer = {
      sign: jest.fn(async () => ({ txType: 14, txInfo: '0x100', txInfoHash: 'hash-100' })),
    };
    const restClient = {
      getNextNonce: jest.fn().mockResolvedValueOnce('100').mockResolvedValueOnce('120'),
      sendTx: jest.fn().mockRejectedValue(new Error('invalid nonce')),
    };
    const manager = new LighterNonceManager({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      signer,
      restClient,
      journalModel: makeJournalModel(journalRows),
    });

    await expect(manager.submit({ action: 'create-order' })).rejects.toThrow('invalid nonce');

    expect(journalRows[0].status).toBe('UNKNOWN');
    expect(journalRows[0].error).toBe('invalid nonce');
    expect(journalRows[0].statusHistory).toEqual(['CREATED', 'SIGNED', 'SENT', 'UNKNOWN']);
    expect(restClient.getNextNonce).toHaveBeenCalledTimes(2);
  });

  it('marks rejected when signing fails before a tx is generated', async () => {
    const journalRows: JournalRecord[] = [];
    const signer = {
      sign: jest.fn().mockRejectedValue(new Error('unsupported signer action: set_leverage')),
    };
    const restClient = {
      getNextNonce: jest.fn().mockResolvedValue('100'),
      sendTx: jest.fn(),
    };
    const manager = new LighterNonceManager({
      exchangeInstanceId: 'lighter-main',
      accountIndex: 7,
      apiKeyIndex: 2,
      signer,
      restClient,
      journalModel: makeJournalModel(journalRows),
    });

    await expect(manager.submit({ action: 'set_leverage' })).rejects.toThrow('unsupported signer action');

    expect(restClient.sendTx).not.toHaveBeenCalled();
    expect(journalRows[0].status).toBe('REJECTED');
    expect(journalRows[0].error).toBe('unsupported signer action: set_leverage');
    expect(journalRows[0].statusHistory).toEqual(['CREATED', 'REJECTED']);
  });
});
