import {
  normalizeLighterBalance,
  normalizeLighterOrders,
  normalizeLighterTrades,
  normalizeLighterTicker,
  normalizeLighterCandles,
} from '../../../../src/services/exchanges/lighter/LighterResponseNormalizer';

describe('LighterResponseNormalizer', () => {
  describe('normalizeLighterBalance', () => {
    it('normalizes account balance from nested account response', () => {
      expect(normalizeLighterBalance({
        account: {
          available_balance: '100.5',
          total_balance: '120.75',
          unrealized_pnl: '-1.25',
        },
      }, 'USDC')).toEqual({
        currency: 'USDC',
        available: '100.5',
        total: '120.75',
        unrealizedPnl: '-1.25',
      });
    });

    it('normalizes account balance from top-level fields', () => {
      expect(normalizeLighterBalance({
        available_balance: '200',
        total_balance: '300',
        unrealized_pnl: '10',
      }, 'USDT')).toEqual({
        currency: 'USDT',
        available: '200',
        total: '300',
        unrealizedPnl: '10',
      });
    });

    it('normalizes account balance with camelCase fields', () => {
      expect(normalizeLighterBalance({
        account: {
          availableBalance: '50',
          totalBalance: '75',
          unrealizedPnl: '5',
        },
      }, 'USDC')).toEqual({
        currency: 'USDC',
        available: '50',
        total: '75',
        unrealizedPnl: '5',
      });
    });

    it('defaults available and total to 0 when missing', () => {
      expect(normalizeLighterBalance({
        account: {},
      }, 'USDC')).toEqual({
        currency: 'USDC',
        available: '0',
        total: '0',
        unrealizedPnl: '',
      });
    });

    it('throws for unrecognized balance response', () => {
      expect(() => normalizeLighterBalance(null, 'USDC')).toThrow(
        'Unrecognized Lighter account balance response',
      );
    });
  });

  describe('normalizeLighterOrders', () => {
    it('normalizes open and protection orders from nested orders array', () => {
      const result = normalizeLighterOrders({
        orders: [{
          client_order_index: '123',
          symbol: 'BTC_USDT',
          side: 'sell',
          price: '65000',
          base_amount: '0.01',
          status: 'OPEN',
          order_type: 'STOP_LOSS',
        }],
      }, 'BTC_USDT');

      expect(result).toEqual([{
        id: '123',
        symbol: 'BTC_USDT',
        side: 'sell',
        price: '65000',
        amount: '0.01',
        status: 'open',
        type: 'STOP_LOSS',
        text: '123',
        raw: expect.any(Object),
      }]);
    });

    it('normalizes orders from top-level array', () => {
      const result = normalizeLighterOrders([{
        client_order_index: '456',
        symbol: 'ETH_USDT',
        side: 'buy',
        price: '3500',
        base_amount: '1.5',
        status: 'FILLED',
        order_type: 'LIMIT',
      }]);

      expect(result).toEqual([{
        id: '456',
        symbol: 'ETH_USDT',
        side: 'buy',
        price: '3500',
        amount: '1.5',
        status: 'filled',
        type: 'LIMIT',
        text: '456',
        raw: expect.any(Object),
      }]);
    });

    it('maps integer order types to string names', () => {
      const result = normalizeLighterOrders([{
        client_order_index: '100',
        order_type: 2,
        status: 'OPEN',
      }]);
      expect(result[0].type).toBe('STOP_LOSS');

      const tp = normalizeLighterOrders([{
        client_order_index: '101',
        order_type: 4,
        status: 'OPEN',
      }]);
      expect(tp[0].type).toBe('TAKE_PROFIT');
    });

    it('normalizes terminal statuses correctly', () => {
      const cancelled = normalizeLighterOrders([{
        client_order_index: '1',
        status: 'CANCELLED',
      }]);
      expect(cancelled[0].status).toBe('cancelled');

      const canceled = normalizeLighterOrders([{
        client_order_index: '2',
        status: 'CANCELED',
      }]);
      expect(canceled[0].status).toBe('cancelled');

      const rejected = normalizeLighterOrders([{
        client_order_index: '3',
        status: 'REJECTED',
      }]);
      expect(rejected[0].status).toBe('rejected');
    });

    it('uses fallbackSymbol when symbol is missing', () => {
      const result = normalizeLighterOrders([{
        client_order_index: '789',
        side: 'buy',
        price: '100',
        base_amount: '1',
        status: 'OPEN',
      }], 'SOL_USDT');

      expect(result[0].symbol).toBe('SOL_USDT');
    });

    it('normalizes camelCase order fields', () => {
      const result = normalizeLighterOrders({
        orders: [{
          clientOrderIndex: '999',
          symbol: 'BTC_USDT',
          side: 'buy',
          price: '60000',
          baseAmount: '0.1',
          status: 'OPEN',
          orderType: 'LIMIT',
        }],
      });

      expect(result[0]).toEqual(expect.objectContaining({
        id: '999',
        amount: '0.1',
        type: 'LIMIT',
      }));
    });

    it('normalizes orders grouped by market id', () => {
      const result = normalizeLighterOrders({
        orders: {
          1: [{
            client_order_index: '1001',
            symbol: 'BTC_USDT',
            is_ask: true,
            price: '65000',
            base_amount: '0.01',
            status: 'OPEN',
            order_type: 'LIMIT',
          }],
        },
      });

      expect(result).toEqual([expect.objectContaining({
        id: '1001',
        symbol: 'BTC_USDT',
        side: 'sell',
        price: '65000',
        amount: '0.01',
        status: 'open',
        type: 'LIMIT',
      })]);
    });

    it('returns empty array for empty orders', () => {
      expect(normalizeLighterOrders({ orders: [] })).toEqual([]);
    });

    it('throws for unrecognized order response', () => {
      expect(() => normalizeLighterOrders({})).toThrow(
        'Unrecognized Lighter orders response',
      );
    });
  });

  describe('normalizeLighterTrades', () => {
    it('normalizes trades from nested trades array', () => {
      const result = normalizeLighterTrades({
        trades: [{
          trade_id: 't100',
          client_order_index: '123',
          symbol: 'BTC_USDT',
          side: 'buy',
          price: '65000',
          base_amount: '0.01',
          is_maker: true,
          created_at: 1700000000000,
        }],
      }, 'BTC_USDT');

      expect(result).toEqual([{
        id: 't100',
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        price: '65000',
        amount: '0.01',
        role: 'maker',
        time: 1700000000000,
        text: '',
        fee: '',
        feeCurrency: 'USDT',
      }]);
    });

    it('normalizes trades from top-level array', () => {
      const result = normalizeLighterTrades([{
        tradeId: 't200',
        orderId: '456',
        symbol: 'ETH_USDT',
        side: 'sell',
        price: '3500',
        amount: '1.5',
        is_maker: false,
        timestamp: 1700000000001,
      }], 'ETH_USDT');

      expect(result[0]).toEqual(expect.objectContaining({
        id: 't200',
        orderId: '456',
        role: 'taker',
        time: 1700000000001,
      }));
    });

    it('uses fallbackSymbol when symbol is missing', () => {
      const result = normalizeLighterTrades([{
        trade_id: 't300',
        order_id: '789',
        side: 'buy',
        price: '100',
        base_amount: '1',
        is_maker: true,
        created_at: 1700000000000,
      }], 'SOL_USDT');

      expect(result[0].symbol).toBe('SOL_USDT');
    });

    it('returns empty array for empty trades', () => {
      expect(normalizeLighterTrades({ trades: [] }, 'BTC_USDT')).toEqual([]);
    });

    it('throws for unrecognized trade response', () => {
      expect(() => normalizeLighterTrades(null, 'BTC_USDT')).toThrow(
        'Unrecognized Lighter trades response',
      );
    });
  });

  describe('normalizeLighterTicker', () => {
    it('normalizes ticker with snake_case fields', () => {
      const result = normalizeLighterTicker({
        ticker: {
          last_price: '65000',
          mark_price: '65005',
          index_price: '65002',
          funding_rate: '0.0001',
          volume_24h: '12345.6',
          price_change_24h: '-2.5',
        },
      }, 'BTC_USDT');

      expect(result).toEqual({
        symbol: 'BTC_USDT',
        lastPrice: '65000',
        markPrice: '65005',
        indexPrice: '65002',
        fundingRate: '0.0001',
        volume24h: '12345.6',
        change24h: '-2.5',
      });
    });

    it('normalizes ticker with camelCase fields', () => {
      const result = normalizeLighterTicker({
        lastPrice: '3500',
        markPrice: '3502',
        indexPrice: '3501',
        fundingRate: '0.0003',
        volume24h: '9876.5',
        change24h: '1.2',
      }, 'ETH_USDT');

      expect(result).toEqual({
        symbol: 'ETH_USDT',
        lastPrice: '3500',
        markPrice: '3502',
        indexPrice: '3501',
        fundingRate: '0.0003',
        volume24h: '9876.5',
        change24h: '1.2',
      });
    });

    it('normalizes ticker from data wrapper', () => {
      const result = normalizeLighterTicker({
        data: {
          last_price: '100',
          mark_price: '101',
          index_price: '100.5',
          funding_rate: '0.0005',
          volume_24h: '500',
          price_change_24h: '0.5',
        },
      }, 'SOL_USDT');

      expect(result.lastPrice).toBe('100');
    });

    it('normalizes ticker from public orderBookDetails response', () => {
      const result = normalizeLighterTicker({
        code: 200,
        order_book_details: [{
          symbol: 'BTC',
          market_id: 1,
          last_trade_price: 81631.6,
          daily_base_token_volume: 1000.5,
          daily_price_change: -1.25,
        }],
      }, 'BTC_USDT');

      expect(result).toEqual({
        symbol: 'BTC_USDT',
        lastPrice: '81631.6',
        markPrice: '81631.6',
        indexPrice: '81631.6',
        fundingRate: '0',
        volume24h: '1000.5',
        change24h: '-1.25',
      });
    });

    it('defaults missing fields to 0', () => {
      const result = normalizeLighterTicker({
        last_price: '100',
      }, 'BTC_USDT');

      expect(result).toEqual({
        symbol: 'BTC_USDT',
        lastPrice: '100',
        markPrice: '',
        indexPrice: '',
        fundingRate: '0',
        volume24h: '0',
        change24h: '0',
      });
    });

    it('throws for unrecognized ticker response', () => {
      expect(() => normalizeLighterTicker(null, 'BTC_USDT')).toThrow(
        'Unrecognized Lighter ticker response',
      );
    });
  });

  describe('normalizeLighterCandles', () => {
    it('normalizes candles from nested candles array', () => {
      const result = normalizeLighterCandles({
        candles: [{
          time: 1700000000,
          open: '65000',
          high: '66000',
          low: '64000',
          close: '65500',
          volume: '100.5',
        }],
      });

      expect(result).toEqual([{
        timestamp: 1700000000,
        open: '65000',
        high: '66000',
        low: '64000',
        close: '65500',
        volume: '100.5',
      }]);
    });

    it('normalizes candles from top-level array', () => {
      const result = normalizeLighterCandles([{
        timestamp: 1700000000,
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        volume: '500',
      }]);

      expect(result[0]).toEqual({
        timestamp: 1700000000,
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        volume: '500',
      });
    });

    it('normalizes candles from data wrapper', () => {
      const result = normalizeLighterCandles({
        data: [{
          t: 1700000000,
          open: '100',
          high: '110',
          low: '90',
          close: '105',
          volume: '500',
        }],
      });

      expect(result[0].timestamp).toBe(1700000000);
    });

    it('returns empty array for empty candles', () => {
      expect(normalizeLighterCandles({ candles: [] })).toEqual([]);
    });

    it('throws for unrecognized candle response', () => {
      expect(() => normalizeLighterCandles(null)).toThrow(
        'Unrecognized Lighter candles response',
      );
    });
  });
});
