import { VirtualExchangeFillHandler } from '../../src/services/VirtualExchangeFillHandler';

jest.mock('../../src/models', () => ({
  __esModule: true,
  Order: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
  VirtualTrade: { findAll: jest.fn() },
  Op: { in: Symbol('in'), like: Symbol('like'), or: Symbol('or') },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/routes/virtualExchange', () => ({
  __esModule: true,
  getVirtualContractMultiplier: jest.fn((symbol: string) => {
    const s = symbol.toUpperCase();
    if (s.startsWith('BTC')) return 0.0001;
    if (s.startsWith('ETH')) return 0.01;
    if (s.startsWith('ME')) return 0.1;
    if (s.startsWith('TAO')) return 0.01;
    return 1;
  }),
}));

const { Order, VirtualTrade } = require('../../src/models');

describe('VirtualExchangeFillHandler', () => {
  let handler: VirtualExchangeFillHandler;

  beforeEach(() => {
    handler = new VirtualExchangeFillHandler();
    jest.clearAllMocks();
  });

  describe('parsePositionLevelSlText', () => {
    it('parses t-sl-pos-{symbol}-{side} format', async () => {
      const order1 = {
        id: 101,
        symbol: 'BTC_USDT',
        lifecycleStatus: 'OPEN',
        side: 'buy',
        filledPrice: '65000',
        filledAmount: '0.5',
        price: '65000',
        amount: '0.5',
        update: jest.fn(),
      };
      const order2 = {
        id: 102,
        symbol: 'BTC_USDT',
        lifecycleStatus: 'PROTECTED',
        side: 'buy',
        filledPrice: '65500',
        filledAmount: '0.3',
        price: '65500',
        amount: '0.3',
        update: jest.fn(),
      };
      Order.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([order1, order2]);

      const info = makeFillInfo({
        text: 't-sl-pos-BTC_USDT-buy',
        orderRole: 'sl',
        symbol: 'BTC_USDT',
        side: 'buy',
        fillPrice: '66000',
      });
      await handler.handleProtectionFill(info);

      expect(Order.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            symbol: 'BTC_USDT',
            side: 'buy',
            lifecycleStatus: { [Symbol.for('in')]: ['OPEN', 'PROTECTED'] },
          }),
        }),
      );

      expect(order1.update).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: '66000',
        closePrice: '66000',
        lastPrice: '66000',
      }));

      expect(order2.update).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: '66000',
        closePrice: '66000',
        lastPrice: '66000',
      }));
    });

    it('calculates P&L correctly for buy order closed by SL', async () => {
      const order = {
        id: 1, symbol: 'ME_USDT', side: 'buy', lifecycleStatus: 'OPEN',
        filledPrice: '0.0947', filledAmount: '30637', price: '0.0947', amount: '30637', leverage: '75',
        update: jest.fn(),
      };
      Order.findAll.mockResolvedValue([order]);

      const info = makeFillInfo({
        text: 't-sl-pos-ME_USDT-buy',
        orderRole: 'sl',
        fillPrice: '0.0931',
        symbol: 'ME_USDT',
        side: 'buy',
      });
      await handler.handleProtectionFill(info);

      // P&L = (0.0931 - 0.0947) * 30637 * 0.1 * 1 = -4.9019 (ME multiplier=0.1)
      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        realizedPnl: '-4.9019',
      }));
    });

    it('calculates P&L correctly for sell order closed by SL', async () => {
      const order = {
        id: 2, symbol: 'BTC_USDT', side: 'sell', lifecycleStatus: 'PROTECTED',
        filledPrice: '67000', filledAmount: '0.1', price: '67000', amount: '0.1', leverage: '20',
        update: jest.fn(),
      };
      Order.findAll.mockResolvedValue([order]);

      const info = makeFillInfo({
        text: 't-sl-pos-BTC_USDT-sell',
        orderRole: 'sl',
        fillPrice: '68000',
        symbol: 'BTC_USDT',
        side: 'sell',
      });
      await handler.handleProtectionFill(info);

      // P&L = (68000 - 67000) * 0.1 * 0.0001 * -1 = -0.01 (BTC multiplier=0.0001)
      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        realizedPnl: '-0.0100',
      }));
    });

    it('handles no matching OPEN/PROTECTED orders gracefully', async () => {
      Order.findAll.mockResolvedValue([]);

      const info = makeFillInfo({
        text: 't-sl-pos-AR_USDT-buy',
        orderRole: 'sl',
        fillPrice: '2.0',
        symbol: 'AR_USDT',
        side: 'buy',
      });
      await handler.handleProtectionFill(info);

      expect(Order.findAll).toHaveBeenCalled();
    });

    it('closes pending order linked to filled position-level stop loss', async () => {
      const order = {
        id: 599,
        symbol: 'ETH_USDT',
        side: 'buy',
        lifecycleStatus: 'PENDING',
        activeStopLossId: 'vo-sl-filled',
        filledPrice: null,
        filledAmount: null,
        price: '1976.04',
        amount: '1225',
        update: jest.fn(),
      };
      Order.findAll.mockResolvedValue([order]);

      const info = makeFillInfo({
        virtualOrderId: 'vo-sl-filled',
        text: 't-sl-pos-ETH_USDT-buy',
        orderRole: 'sl',
        fillPrice: '1971.96',
        symbol: 'ETH_USDT',
        side: 'sell',
      });
      await handler.handleProtectionFill(info);

      expect(Order.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            activeStopLossId: 'vo-sl-filled',
          }),
        }),
      );
      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: '1971.96',
      }));
    });

    it('falls back to order.price when filledPrice is empty', async () => {
      const order = {
        id: 3, symbol: 'TAO_USDT', side: 'buy', lifecycleStatus: 'OPEN',
        filledPrice: null, filledAmount: null, price: '271.1', amount: '4.9', leverage: '20',
        update: jest.fn(),
      };
      Order.findAll.mockResolvedValue([order]);

      const info = makeFillInfo({
        text: 't-sl-pos-TAO_USDT-buy',
        orderRole: 'sl',
        fillPrice: '260',
        symbol: 'TAO_USDT',
        side: 'buy',
      });
      await handler.handleProtectionFill(info);

      // P&L = (260 - 271.1) * 4.9 * 0.01 * 1 = -0.5439 (TAO multiplier=0.01)
      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        realizedPnl: '-0.5439',
      }));
    });

    it('does not match non-position-level SL text', async () => {
      const info = makeFillInfo({
        text: 'close-position',
        orderRole: 'close',
      });
      await handler.handleProtectionFill(info);

      expect(Order.findAll).not.toHaveBeenCalled();
    });
  });

  describe('extractOrderId', () => {
    it('extracts order ID from t-sl-ord-{id} pattern', async () => {
      const order = { id: 42, lifecycleStatus: 'PROTECTED', update: jest.fn() };
      Order.findByPk.mockResolvedValue(order);
      VirtualTrade.findAll.mockResolvedValue([]);

      const info = makeFillInfo({ text: 't-sl-ord-42', orderRole: 'sl' });
      await handler.handleProtectionFill(info);

      expect(Order.findByPk).toHaveBeenCalledWith(42);
    });

    it('extracts order ID from t-tp-{index}-ord-{id} pattern', async () => {
      const order = { id: 99, lifecycleStatus: 'PROTECTED', update: jest.fn() };
      Order.findByPk.mockResolvedValue(order);
      VirtualTrade.findAll.mockResolvedValue([]);

      const info = makeFillInfo({ text: 't-tp-1-ord-99', orderRole: 'tp' });
      await handler.handleProtectionFill(info);

      expect(Order.findByPk).toHaveBeenCalledWith(99);
    });

    it('closes order linked by virtual exchange order ID in TP text', async () => {
      const order = { id: 123, lifecycleStatus: 'PROTECTED', update: jest.fn() };
      Order.findOne.mockResolvedValue(order);
      VirtualTrade.findAll.mockResolvedValue([]);

      const info = makeFillInfo({
        text: 't-tp-1-vo-1780327424744-e63vjj',
        orderRole: 'tp',
        fillPrice: '1964.99',
      });
      await handler.handleProtectionFill(info);

      expect(Order.findOne).toHaveBeenCalledWith({
        where: { exchangeOrderId: 'vo-1780327424744-e63vjj' },
      });
      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: '1964.99',
      }));
    });

    it('skips already CLOSED orders', async () => {
      const order = { id: 10, lifecycleStatus: 'CLOSED', update: jest.fn() };
      Order.findByPk.mockResolvedValue(order);

      const info = makeFillInfo({ text: 't-sl-ord-10', orderRole: 'sl' });
      await handler.handleProtectionFill(info);

      expect(order.update).not.toHaveBeenCalled();
    });

    it('updates order with P&L from callback', async () => {
      const order = { id: 50, lifecycleStatus: 'PROTECTED', update: jest.fn() };
      Order.findByPk.mockResolvedValue(order);

      const info = makeFillInfo({
        text: 't-sl-ord-50',
        orderRole: 'sl',
        fillPrice: '67000',
        realizedPnl: -5.5,
      });
      await handler.handleProtectionFill(info);

      expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: '67000',
        closePrice: '67000',
        lastPrice: '67000',
        realizedPnl: '-5.5000',
      }));
    });

    it('warns and returns when text is null', async () => {
      const info = makeFillInfo({ text: null, orderRole: 'sl' });
      await handler.handleProtectionFill(info);

      expect(Order.findByPk).not.toHaveBeenCalled();
    });

    it('warns and returns when order not found', async () => {
      Order.findByPk.mockResolvedValue(null);

      const info = makeFillInfo({ text: 't-sl-ord-999', orderRole: 'sl' });
      await handler.handleProtectionFill(info);
    });
  });
});

function makeFillInfo(overrides: Record<string, any> = {}) {
  return {
    virtualOrderId: 'vo-test',
    symbol: 'BTC_USDT',
    side: 'buy' as const,
    orderRole: 'sl' as const,
    fillPrice: '67000',
    filledAmount: '100',
    realizedPnl: 0,
    text: null,
    exchangeInstanceId: 'v-raizexbt',
    timestamp: new Date(),
    ...overrides,
  };
}
