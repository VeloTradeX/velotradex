import AdmZip from 'adm-zip';
import { BackupService } from '../../src/services/BackupService';
import { sequelize } from '../../src/db';
import logger from '../../src/utils/logger';

jest.mock('../../src/db', () => ({
  sequelize: {
    models: {},
    transaction: jest.fn(),
  },
}));

jest.mock('adm-zip', () => {
  class MockAdmZip {
    static files: Array<{ entryName: string; content: Buffer }> = [];
    static entries: any[] = [];

    constructor(_buffer?: Buffer) {}

    addFile = jest.fn((entryName: string, content: Buffer) => {
      MockAdmZip.files.push({ entryName, content });
    });

    toBuffer = jest.fn(() => Buffer.from('mock-zip-content'));

    getEntries = jest.fn(() => MockAdmZip.entries);
  }

  return { __esModule: true, default: MockAdmZip };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('BackupService', () => {
  const mockedTransaction = sequelize.transaction as unknown as jest.Mock;
  const mockedFiles = (AdmZip as any).files as Array<{ entryName: string; content: Buffer }>;
  const mockedEntries = (AdmZip as any).entries as any[];

  const belongsTo = (target: string) => ({
    associationType: 'BelongsTo',
    target: { name: target },
  });
  const hasMany = (target: string) => ({
    associationType: 'HasMany',
    target: { name: target },
  });

  const makeModel = (name: string, associations: Record<string, any> = {}) => ({
    name,
    associations,
    findAll: jest.fn(),
    destroy: jest.fn(),
    bulkCreate: jest.fn(),
  });

  const zipEntry = (entryName: string, data: any) => ({
    entryName,
    getData: () => ({ toString: () => JSON.stringify(data) }),
  });

  const readExportedFile = (entryName: string) => {
    const file = mockedFiles.find((f) => f.entryName === entryName);
    return file ? JSON.parse(file.content.toString()) : undefined;
  };

  const setModels = (models: Record<string, any>) => {
    (sequelize as any).models = models;
  };

  const installImportZip = (tables: string[], tableData: Record<string, any[]>) => {
    mockedEntries.push(zipEntry('metadata.json', { version: '1.0', tables }));
    for (const [tableName, data] of Object.entries(tableData)) {
      mockedEntries.push(zipEntry(`${tableName}.json`, data));
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFiles.length = 0;
    mockedEntries.length = 0;
    setModels({});
  });

  describe('getTables', () => {
    it('lists all registered model names', () => {
      setModels({ Order: makeModel('Order'), User: makeModel('User') });

      expect(new BackupService().getTables()).toEqual(['Order', 'User']);
    });
  });

  describe('getRelatedTables', () => {
    it('resolves related tables transitively across associations', () => {
      setModels({
        Strategy: makeModel('Strategy', { Orders: hasMany('Order') }),
        Order: makeModel('Order', {
          Strategy: belongsTo('Strategy'),
          Positions: hasMany('StrategyPosition'),
        }),
        StrategyPosition: makeModel('StrategyPosition', { Order: belongsTo('Order') }),
        Unrelated: makeModel('Unrelated'),
      });

      const related = new BackupService().getRelatedTables(['Strategy']);

      expect(related.sort()).toEqual(['Order', 'Strategy', 'StrategyPosition']);
    });

    it('keeps unknown table names in the result even without a matching model', () => {
      setModels({});

      const related = new BackupService().getRelatedTables(['Ghost']);

      // Current behavior: selected names are added to the visited set
      // before checking whether a model exists.
      expect(related).toEqual(['Ghost']);
    });
  });

  describe('exportData', () => {
    it('writes one JSON file per table plus metadata and returns the zip buffer', async () => {
      const userModel = makeModel('User');
      userModel.findAll.mockResolvedValue([
        { get: jest.fn(() => ({ id: 1, username: 'admin' })) },
      ]);
      setModels({ User: userModel });

      const buffer = await new BackupService().exportData(['User']);

      expect(buffer.toString()).toBe('mock-zip-content');
      expect(mockedFiles.map((f) => f.entryName).sort()).toEqual(['User.json', 'metadata.json']);
      expect(readExportedFile('User.json')).toEqual([{ id: 1, username: 'admin' }]);
      expect(userModel.findAll).toHaveBeenCalledWith();

      const metadata = readExportedFile('metadata.json');
      expect(metadata.version).toBe('1.0');
      expect(metadata.tables).toEqual(['User']);
      expect(typeof metadata.timestamp).toBe('string');
    });

    it('skips missing models during export but still lists them in metadata', async () => {
      setModels({});

      await new BackupService().exportData(['Ghost']);

      expect(mockedFiles.map((f) => f.entryName)).toEqual(['metadata.json']);
      expect(readExportedFile('metadata.json').tables).toEqual(['Ghost']);
    });
  });

  describe('importData', () => {
    const makeTransaction = () => ({ commit: jest.fn(), rollback: jest.fn() });

    it('rejects backups without metadata.json before opening a transaction', async () => {
      mockedEntries.push(zipEntry('User.json', [{ id: 1 }]));

      await expect(new BackupService().importData(Buffer.from('zip'))).rejects.toThrow(
        'Invalid backup file: Missing metadata.json'
      );
      expect(mockedTransaction).not.toHaveBeenCalled();
    });

    it('clears tables in reverse order, inserts parents-first, and commits', async () => {
      const tx = makeTransaction();
      mockedTransaction.mockResolvedValue(tx);
      const userModel = makeModel('User', { Orders: hasMany('Order') });
      const orderModel = makeModel('Order', { User: belongsTo('User') });
      setModels({ User: userModel, Order: orderModel });
      installImportZip(['Order', 'User'], {
        User: [{ id: 1 }],
        Order: [{ id: 10, userId: 1 }],
      });

      await new BackupService().importData(Buffer.from('zip'));

      expect(logger.info).toHaveBeenCalledWith('Import order: User -> Order');
      // Destroy happens in reverse topological order (children first).
      expect(orderModel.destroy.mock.invocationCallOrder[0]).toBeLessThan(
        userModel.destroy.mock.invocationCallOrder[0]
      );
      expect(orderModel.destroy).toHaveBeenCalledWith({ where: {}, transaction: tx });
      // Inserts happen in topological order (parents first).
      expect(userModel.bulkCreate.mock.invocationCallOrder[0]).toBeLessThan(
        orderModel.bulkCreate.mock.invocationCallOrder[0]
      );
      expect(userModel.bulkCreate).toHaveBeenCalledWith(
        [{ id: 1 }],
        expect.objectContaining({ transaction: tx, validate: true })
      );
      expect(orderModel.bulkCreate).toHaveBeenCalledWith(
        [{ id: 10, userId: 1 }],
        expect.objectContaining({ transaction: tx })
      );
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
    });

    it('still clears tables whose dataset is empty but skips their bulkCreate', async () => {
      const tx = makeTransaction();
      mockedTransaction.mockResolvedValue(tx);
      const userModel = makeModel('User');
      setModels({ User: userModel });
      installImportZip(['User'], { User: [] });

      await new BackupService().importData(Buffer.from('zip'));

      expect(userModel.destroy).toHaveBeenCalledWith({ where: {}, transaction: tx });
      expect(userModel.bulkCreate).not.toHaveBeenCalled();
      expect(tx.commit).toHaveBeenCalledTimes(1);
    });

    it('rolls back and rethrows when an insert fails', async () => {
      const tx = makeTransaction();
      mockedTransaction.mockResolvedValue(tx);
      const userModel = makeModel('User');
      userModel.bulkCreate.mockRejectedValue(new Error('constraint failed'));
      setModels({ User: userModel });
      installImportZip(['User'], { User: [{ id: 1 }] });

      await expect(new BackupService().importData(Buffer.from('zip'))).rejects.toThrow(
        'constraint failed'
      );

      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('Import failed: Error: constraint failed');
    });

    it('falls back to append order when tables form a dependency cycle', async () => {
      const tx = makeTransaction();
      mockedTransaction.mockResolvedValue(tx);
      const modelA = makeModel('TableA', { B: belongsTo('TableB') });
      const modelB = makeModel('TableB', { A: belongsTo('TableA') });
      setModels({ TableA: modelA, TableB: modelB });
      installImportZip(['TableA', 'TableB'], {
        TableA: [{ id: 1 }],
        TableB: [{ id: 2 }],
      });

      await new BackupService().importData(Buffer.from('zip'));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Topological sort incomplete')
      );
      expect(modelA.bulkCreate).toHaveBeenCalledWith(
        [{ id: 1 }],
        expect.objectContaining({ transaction: tx })
      );
      expect(modelB.bulkCreate).toHaveBeenCalledWith(
        [{ id: 2 }],
        expect.objectContaining({ transaction: tx })
      );
      expect(tx.commit).toHaveBeenCalledTimes(1);
    });
  });
});
