import { EventEmitter } from 'events';
import { LighterOrderPersistenceHandler } from '../../../../src/services/exchanges/lighter/LighterOrderPersistenceHandler';

jest.mock('../../../../src/models', () => ({
  Order: { findOne: jest.fn(), findAll: jest.fn() },
  StrategyPosition: { findAll: jest.fn() },
  PendingProtection: { findByPk: jest.fn() },
}));

jest.mock('../../../../src/models/LighterClientOrderIndex', () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock('../../../../src/models/LighterTxJournal', () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock('../../../../src/services/AuditService', () => ({
  __esModule: true,
  default: { logByExchangeOrderId: jest.fn() },
}));

import { Order, StrategyPosition, PendingProtection } from '../../../../src/models';
import LighterClientOrderIndex from '../../../../src/models/LighterClientOrderIndex';
import LighterTxJournal from '../../../../src/models/LighterTxJournal';
import auditService from '../../../../src/services/AuditService';

describe('LighterOrderPersistenceHandler', () => {
  let reconciler: EventEmitter;
  let mockExchange: any;
  let mockPipeline: any;
  let handler: LighterOrderPersistenceHandler;

  beforeEach(() => {
    reconciler = new EventEmitter();
    mockExchange = {
      getPosition: jest.fn().mockResolvedValue(null),
      getOpenOrders: jest.fn().mockResolvedValue([]),
    };
    mockPipeline = {
      placeProtections: jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true }),
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn().mockResolvedValue(undefined),
    };

    handler = new LighterOrderPersistenceHandler(reconciler, mockExchange);
    handler.setProtectionPipeline(mockPipeline);

    jest.clearAllMocks();
    jest.restoreAllMocks();
    // Reset mock implementations cleared by clearAllMocks
    (Order.findOne as jest.Mock).mockReset();
    (Order.findAll as jest.Mock).mockReset();
    (StrategyPosition.findAll as jest.Mock).mockReset();
    (PendingProtection.findByPk as jest.Mock).mockReset();
    (LighterClientOrderIndex.findOne as jest.Mock).mockReset();
    (LighterTxJournal.findOne as jest.Mock).mockReset();
  });

  afterEach(() => {
    reconciler.removeAllListeners();
  });

  describe('entry order fill', () => {
    it('updates Order status and triggers PendingProtection on entry fill', async () => {
      const mockOrder = {
        exchangeOrderId: '12345',
        lifecycleStatus: 'PENDING',
        status: 'open',
        filledAmount: '0',
        filledPrice: '0',
        symbol: 'ETHUSDT',
        side: 'buy',
        amount: '1',
        save: jest.fn(),
      };
      (Order.findOne as jest.Mock).mockResolvedValue(mockOrder);
      (PendingProtection.findByPk as jest.Mock).mockResolvedValue({
        orderId: '12345',
        symbol: 'ETHUSDT',
        side: 'buy',
        stopLoss: '2400',
        takeProfit: null,
      });

      reconciler.emit('order', {
        id: '12345',
        status: 'filled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockOrder.lifecycleStatus).toBe('PROTECTED');
      expect(mockOrder.status).toBe('filled');
      expect(mockOrder.filledAmount).toBe('1');
      expect(mockOrder.filledPrice).toBe('2500');
      expect(mockOrder.save).toHaveBeenCalled();
      expect(mockPipeline.placeProtections).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: '12345',
          stopLossPrice: '2400',
          source: 'lighter-ws-handler',
        }),
      );
    });

    it('does not trigger PendingProtection when none exists', async () => {
      const mockOrder = {
        exchangeOrderId: '12345',
        lifecycleStatus: 'PENDING',
        status: 'open',
        amount: '1',
        save: jest.fn(),
      };
      (Order.findOne as jest.Mock).mockResolvedValue(mockOrder);
      (PendingProtection.findByPk as jest.Mock).mockResolvedValue(null);

      reconciler.emit('order', {
        id: '12345',
        status: 'filled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPipeline.placeProtections).not.toHaveBeenCalled();
    });

    it('skips update if lifecycleStatus is already OPEN', async () => {
      const mockOrder = {
        exchangeOrderId: '12345',
        lifecycleStatus: 'OPEN',
        status: 'filled',
        amount: '1',
        save: jest.fn(),
      };
      (Order.findOne as jest.Mock).mockResolvedValue(mockOrder);
      (PendingProtection.findByPk as jest.Mock).mockResolvedValue(null);

      reconciler.emit('order', {
        id: '12345',
        status: 'filled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockOrder.save).not.toHaveBeenCalled();
    });
  });

  describe('TP fill', () => {
    it('calls moveStopLossToBreakeven on TP1 fill', async () => {
      let findOneCallCount = 0;
      (Order.findOne as jest.Mock).mockImplementation(async () => {
        findOneCallCount++;
        // Calls 1-3: findDbOrder (returns null — TP order has no DB record)
        // Call 4: handleTpFill linked order lookup
        if (findOneCallCount === 4) {
          return { exchangeOrderId: '1001', symbol: 'ETHUSDT', side: 'buy' };
        }
        return null;
      });
      (LighterClientOrderIndex.findOne as jest.Mock).mockResolvedValue({
        businessKey: 't-tp-1-1001',
      });
      (StrategyPosition.findAll as jest.Mock).mockResolvedValue([]);

      reconciler.emit('order', {
        id: 'tp-order-idx',
        status: 'filled',
        amount: '0.5',
        price: '2800',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPipeline.moveStopLossToBreakeven).toHaveBeenCalledWith('1001');
    });

    it('does not call moveStopLossToBreakeven on TP2 fill', async () => {
      let findOneCallCount = 0;
      (Order.findOne as jest.Mock).mockImplementation(async () => {
        findOneCallCount++;
        if (findOneCallCount === 4) {
          return { exchangeOrderId: '1001', symbol: 'ETHUSDT', side: 'buy' };
        }
        return null;
      });
      (LighterClientOrderIndex.findOne as jest.Mock).mockResolvedValue({
        businessKey: 't-tp-2-1001',
      });
      (StrategyPosition.findAll as jest.Mock).mockResolvedValue([]);

      reconciler.emit('order', {
        id: 'tp-order-idx',
        status: 'filled',
        amount: '0.5',
        price: '3000',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPipeline.moveStopLossToBreakeven).not.toHaveBeenCalled();
    });

    it('cancels SL when all TPs filled and position closed', async () => {
      let findOneCallCount = 0;
      (Order.findOne as jest.Mock).mockImplementation(async () => {
        findOneCallCount++;
        if (findOneCallCount === 4) {
          return { exchangeOrderId: '1001', symbol: 'ETHUSDT', side: 'buy' };
        }
        return null;
      });
      (LighterClientOrderIndex.findOne as jest.Mock).mockResolvedValue({
        businessKey: 't-tp-1-1001',
      });
      (StrategyPosition.findAll as jest.Mock).mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([]);
      mockExchange.getPosition.mockResolvedValue({ size: '0' });

      reconciler.emit('order', {
        id: 'tp-order-idx',
        status: 'filled',
        amount: '0.5',
        price: '2800',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPipeline.cancelProtections).toHaveBeenCalledWith('ETHUSDT', 'buy');
    });

    it('does not cancel SL when position still open', async () => {
      let findOneCallCount = 0;
      (Order.findOne as jest.Mock).mockImplementation(async () => {
        findOneCallCount++;
        if (findOneCallCount === 4) {
          return { exchangeOrderId: '1001', symbol: 'ETHUSDT', side: 'buy' };
        }
        return null;
      });
      (LighterClientOrderIndex.findOne as jest.Mock).mockResolvedValue({
        businessKey: 't-tp-1-1001',
      });
      (StrategyPosition.findAll as jest.Mock).mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([]);
      mockExchange.getPosition.mockResolvedValue({ size: '1.5' });

      reconciler.emit('order', {
        id: 'tp-order-idx',
        status: 'filled',
        amount: '0.5',
        price: '2800',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPipeline.cancelProtections).not.toHaveBeenCalled();
    });

    it('reduces StrategyPosition.remainingSize on TP fill', async () => {
      const mockPosition = { remainingSize: '2.0', update: jest.fn() };
      let findOneCallCount = 0;
      (Order.findOne as jest.Mock).mockImplementation(async () => {
        findOneCallCount++;
        if (findOneCallCount === 4) {
          return { exchangeOrderId: '1001', symbol: 'ETHUSDT', side: 'buy' };
        }
        return null;
      });
      (LighterClientOrderIndex.findOne as jest.Mock).mockResolvedValue({
        businessKey: 't-tp-1-1001',
      });
      (StrategyPosition.findAll as jest.Mock).mockResolvedValue([mockPosition]);

      reconciler.emit('order', {
        id: 'tp-order-idx',
        status: 'filled',
        amount: '0.5',
        price: '2800',
        raw: { symbol: 'ETHUSDT' },
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockPosition.update).toHaveBeenCalledWith({ remainingSize: '1.5' });
    });
  });

  describe('order cancel', () => {
    it('updates lifecycleStatus to CLOSED on cancel', async () => {
      const mockOrder = {
        exchangeOrderId: '12345',
        lifecycleStatus: 'OPEN',
        status: 'filled',
        save: jest.fn(),
      };
      (Order.findOne as jest.Mock).mockResolvedValue(mockOrder);

      reconciler.emit('order', {
        id: '12345',
        status: 'cancelled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockOrder.lifecycleStatus).toBe('CLOSED');
      expect(mockOrder.status).toBe('cancelled');
      expect(mockOrder.save).toHaveBeenCalled();
    });

    it('ignores cancel for non-existent order', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue(null);

      reconciler.emit('order', {
        id: '99999',
        status: 'cancelled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      // Should not throw
      expect(auditService.logByExchangeOrderId).not.toHaveBeenCalled();
    });
  });

  describe('safety', () => {
    it('safely skips protection when no pipeline is set', async () => {
      const freshReconciler = new EventEmitter();
      const handlerNoPipeline = new LighterOrderPersistenceHandler(freshReconciler, mockExchange);
      const mockOrder = {
        exchangeOrderId: '12345',
        lifecycleStatus: 'PENDING',
        status: 'open',
        amount: '1',
        save: jest.fn(),
      };
      (Order.findOne as jest.Mock).mockResolvedValue(mockOrder);
      (PendingProtection.findByPk as jest.Mock).mockResolvedValue({});

      freshReconciler.emit('order', {
        id: '12345',
        status: 'filled',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockOrder.lifecycleStatus).toBe('OPEN');
      expect(mockPipeline.placeProtections).not.toHaveBeenCalled();
    });

    it('ignores non-terminal statuses', async () => {
      reconciler.emit('order', {
        id: '12345',
        status: 'open',
        amount: '1',
        price: '2500',
        raw: {},
      });

      await new Promise(r => setTimeout(r, 10));

      expect(Order.findOne).not.toHaveBeenCalled();
    });
  });
});
