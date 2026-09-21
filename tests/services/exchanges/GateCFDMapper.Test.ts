/**
 * GateCFDMapper 单元测试 —— 纯映射，不依赖实盘。
 * 覆盖：订单行/持仓行/品种规格/ticker/统一模型映射（fundingRate=0、size 带符号、positionId 透传）。
 */
import { GateCFDMapper } from '../../../src/services/exchanges/gate_cfd/GateCFDMapper';

describe('GateCFDMapper', () => {
  test('mapTicker：CFD 无资金费率，fundingRate 固定 0', () => {
    const t = GateCFDMapper.mapTicker(
      { lastPrice: '2901.5', bidPrice: '2901.0', askPrice: '2902.0', status: 'OPEN' },
      'XAUUSD',
    );
    expect(t.symbol).toBe('XAUUSD');
    expect(t.lastPrice).toBe('2901.5');
    expect(t.fundingRate).toBe('0');
  });

  test('mapOrderRow：side 归一化（1买/2卖）、priceType 归一化、finished 归一化', () => {
    // SDK OrderListDataList.PriceType 枚举：Market=0、Trigger=1（注意与下单请求枚举方向相反）
    const buy = GateCFDMapper.mapOrderRow({
      orderId: 123, symbol: 'XAUUSD', side: 1, priceType: 0,
      volume: '0.01', price: '2900', state: 1, stateDesc: 'pending', finished: 0,
    });
    expect(buy.side).toBe('buy');
    expect(buy.priceType).toBe('Market');
    expect(buy.finished).toBe(false);

    const sell = GateCFDMapper.mapOrderRow({
      orderId: 124, symbol: 'XAUUSD', side: 2, priceType: 1,
      volume: '0.02', price: '2900', finished: 1,
    });
    expect(sell.side).toBe('sell');
    expect(sell.priceType).toBe('Trigger');
    expect(sell.finished).toBe(true);
  });

  test('mapPositionRow：positionDir 归一化', () => {
    const p = GateCFDMapper.mapPositionRow({
      positionId: 999, symbol: 'XAUUSD', volume: '0.02', priceOpen: '2900',
      positionDir: 'buy', unrealizedPnl: '1.5',
    });
    expect(p.positionId).toBe(999);
    expect(p.positionDir).toBe('buy');
    expect(p.volume).toBe('0.02');
  });

  test('toMarketInfo：multiplier=contractVolume、minSize=minOrderVolume、maxSize=maxOrderVolume、amountPrecision=2', () => {
    const m = GateCFDMapper.toMarketInfo({
      symbol: 'XAUUSD', contractVolume: '100', minOrderVolume: '0.01',
      maxOrderVolume: '10', pricePrecision: 2, leverage: '100',
    });
    expect(m.baseCurrency).toBe('XAUUSD');
    expect(m.quoteCurrency).toBe('USDT');
    expect(m.multiplier).toBe('100');
    expect(m.minSize).toBe('0.01');
    expect(m.maxSize).toBe('10');
    expect(m.amountPrecision).toBe(2);
    expect(m.leverageMax).toBe('100');
    expect(m.tickSize).toBe('0.01');
  });

  test('toPosition：size 带符号（buy=+volume，sell=−volume），positionId/price_tp/price_sl 透传', () => {
    const long = GateCFDMapper.toPosition({
      positionId: 11, symbol: 'XAUUSD', volume: '0.02', priceOpen: '2900',
      positionDir: 'buy', priceTp: '2920', priceSl: '2880',
    });
    expect(long.size).toBe('0.02');
    expect(long.position_id).toBe('11'); // positionId 按字符串透传
    expect(long.price_tp).toBe('2920');
    expect(long.price_sl).toBe('2880');
    expect(long.marginType).toBe('cross');

    const short = GateCFDMapper.toPosition({
      positionId: 12, symbol: 'XAUUSD', volume: '0.03', priceOpen: '2900', positionDir: 'sell',
    });
    expect(short.size).toBe('-0.03');
  });

  test('toAccountBalance：available=marginFree、total=equity', () => {
    const b = GateCFDMapper.toAccountBalance({ equity: '10000', marginFree: '9000', margin: '1000' });
    expect(b.currency).toBe('USDT');
    expect(b.total).toBe('10000');
    expect(b.available).toBe('9000');
  });
});
