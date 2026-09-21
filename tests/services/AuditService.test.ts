import { AuditLog, Order } from '../../src/models';
import logger from '../../src/utils/logger';
import webhookService from '../../src/services/WebhookService';
import auditService from '../../src/services/AuditService';

jest.mock('../../src/models', () => ({
  AuditLog: {
    create: jest.fn(),
  },
  Order: {
    findByPk: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  formatError: jest.fn((e: any) => ({ errorMessage: e?.message, errorName: e?.name })),
}));

jest.mock('../../src/services/WebhookService', () => ({
  __esModule: true,
  default: {
    dispatch: jest.fn(),
  },
}));

describe('AuditService', () => {
  beforeEach(() => {
    (AuditLog.create as jest.Mock).mockResolvedValue({});
    (Order.findByPk as jest.Mock).mockResolvedValue(null);
    (Order.findOne as jest.Mock).mockResolvedValue(null);
    (webhookService.dispatch as jest.Mock).mockResolvedValue(undefined);
  });

  describe('log', () => {
    it('persists an audit entry with stringified details', async () => {
      await auditService.log(7, 'ORDER_INIT', { leverage: 10 }, undefined, 'OPEN', 'inst-1', undefined);

      expect(AuditLog.create).toHaveBeenCalledWith({
        strategyId: 7,
        orderId: undefined,
        action: 'ORDER_INIT',
        lifecycleStatus: 'OPEN',
        exchangeInstanceId: 'inst-1',
        routeId: null,
        details: '{"leverage":10}',
      });
    });

    it('passes through details that are already strings', async () => {
      await auditService.log(7, 'ORDER_INIT', 'raw-details');

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ details: 'raw-details' }),
      );
    });

    it('backfills lifecycleStatus and exchangeInstanceId from the order', async () => {
      (Order.findByPk as jest.Mock).mockResolvedValue({
        id: 5,
        lifecycleStatus: 'FILLED',
        exchangeInstanceId: 'ex-2',
      });

      await auditService.log(7, 'ORDER_FILLED_WS', { price: '100' }, 5);

      expect(Order.findByPk).toHaveBeenCalledWith(5);
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycleStatus: 'FILLED', exchangeInstanceId: 'ex-2' }),
      );
    });

    it('prefers the explicitly provided lifecycleStatus over the order one', async () => {
      (Order.findByPk as jest.Mock).mockResolvedValue({
        id: 5,
        lifecycleStatus: 'FILLED',
        exchangeInstanceId: 'ex-2',
      });

      await auditService.log(7, 'ORDER_FILLED_WS', {}, 5, 'CLOSED');

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycleStatus: 'CLOSED' }),
      );
    });

    it('still writes the entry when the order cannot be found', async () => {
      await auditService.log(7, 'ORDER_CLOSED_POSITION', {}, 99);

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 99,
          lifecycleStatus: undefined,
          exchangeInstanceId: undefined,
        }),
      );
    });

    it('dispatches a webhook with parser and symbol metadata', async () => {
      await auditService.log(7, 'ORDER_CREATED', { parser: 'p1', symbol: 'BTC_USDT', price: '100' }, 5, 'OPEN', 'ex-2', 3);

      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'ORDER_CREATED',
        expect.objectContaining({
          strategyId: 7,
          orderId: 5,
          lifecycleStatus: 'OPEN',
          exchangeInstanceId: 'ex-2',
          routeId: 3,
          parser: 'p1',
          symbol: 'BTC_USDT',
          details: { parser: 'p1', symbol: 'BTC_USDT', price: '100' },
        }),
      );
    });

    it('falls back to parsed.symbol when details.symbol is missing', async () => {
      await auditService.log(7, 'STRATEGY_DETECTED', { parsed: { symbol: 'ETH_USDT' } });

      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'STRATEGY_DETECTED',
        expect.objectContaining({ symbol: 'ETH_USDT', parser: undefined }),
      );
    });

    it('swallows AuditLog.create failures', async () => {
      (AuditLog.create as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(auditService.log(7, 'ORDER_INIT', {})).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith('Failed to write audit log', {
        errorMessage: 'db down',
        errorName: 'Error',
      });
    });

    it('swallows webhook dispatch rejections', async () => {
      (webhookService.dispatch as jest.Mock).mockRejectedValue(new Error('network down'));

      await expect(auditService.log(7, 'ORDER_INIT', {})).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledWith('Webhook dispatch failed', {
        errorMessage: 'network down',
        errorName: 'Error',
      });
    });
  });

  describe('logByExchangeOrderId', () => {
    it('delegates to log for a known exchange order id', async () => {
      const order = {
        id: 11,
        strategyId: 3,
        lifecycleStatus: 'OPEN',
        exchangeInstanceId: 'ex-9',
      };
      (Order.findOne as jest.Mock).mockResolvedValue(order);
      (Order.findByPk as jest.Mock).mockResolvedValue(order);

      await auditService.logByExchangeOrderId('eo-1', 'ORDER_FILLED_WS', { price: '100' });

      expect(Order.findOne).toHaveBeenCalledWith({ where: { exchangeOrderId: 'eo-1' } });
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyId: 3,
          orderId: 11,
          action: 'ORDER_FILLED_WS',
          lifecycleStatus: 'OPEN',
          exchangeInstanceId: 'ex-9',
        }),
      );
    });

    it('skips writing when no order matches the exchange order id', async () => {
      await auditService.logByExchangeOrderId('unknown', 'ORDER_FILLED_WS', {});

      expect(AuditLog.create).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'AuditService: Could not find order for exchange ID',
        { exchangeOrderId: 'unknown' },
      );
    });
  });

  describe('logBySymbol', () => {
    it('links the most recent order for the symbol', async () => {
      const order = {
        id: 12,
        strategyId: 4,
        lifecycleStatus: 'OPEN',
        exchangeInstanceId: 'ex-4',
      };
      (Order.findOne as jest.Mock).mockResolvedValue(order);
      (Order.findByPk as jest.Mock).mockResolvedValue(order);

      await auditService.logBySymbol('BTC_USDT', 'ORDER_CLOSED_BY_TRIGGER', { closePrice: '101' });

      expect(Order.findOne).toHaveBeenCalledWith({
        where: { symbol: 'BTC_USDT' },
        order: [['createdAt', 'DESC']],
      });
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ strategyId: 4, orderId: 12, action: 'ORDER_CLOSED_BY_TRIGGER' }),
      );
    });

    it('warns when no recent order (or no strategy) exists for the symbol', async () => {
      await auditService.logBySymbol('ETH_USDT', 'ORDER_CLOSED_BY_TRIGGER', {});
      expect(AuditLog.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();

      (Order.findOne as jest.Mock).mockResolvedValue({ id: 12, strategyId: null });
      await auditService.logBySymbol('ETH_USDT', 'ORDER_CLOSED_BY_TRIGGER', {});
      expect(AuditLog.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });
});
