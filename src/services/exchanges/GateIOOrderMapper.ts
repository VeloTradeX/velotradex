import { OrderResult, Position, Ticker, Candle, Trade } from './IExchange';

export function mapOrderResult(d: any): OrderResult {
    const size = Math.abs(parseFloat(d.size ?? '0'));
    let filled = size;
    // P0-2: finished 订单若 left > 0 表示部分成交（IOC 部分成交 / 部分取消），
    // 返回实际成交量而不是请求量，避免保护单按全量计算。
    if (d.status === 'finished' && d.left != null) {
        const left = Math.abs(parseFloat(d.left ?? '0'));
        filled = Math.max(0, size - left);
    }
    return {
        id: d.id.toString(),
        status: d.status,
        amount: (filled > 1e-8 ? filled : size).toString(),
        price: d.fillPrice || d.price,
        raw: d
    };
}

export function mapOpenOrderResult(o: any): OrderResult {
    return {
        id: o.id.toString(),
        symbol: o.contract,
        status: o.status,
        price: o.price,
        amount: Math.abs(Number(o.size)).toString(),
        text: o.text,
        raw: o
    };
}

export function mapPriceOrderResult(o: any): OrderResult {
    return {
        ...o,
        id: o.id.toString(),
        symbol: o.initial.contract,
        status: 'open',
        price: o.initial.price,
        amount: o.initial.size,
        // SDK deserializes API responses to camelCase (reduceOnly, isReduceOnly, autoSize),
        // but also check snake_case for robustness against raw API data.
        reduce_only: o.initial.reduceOnly ?? o.initial.reduce_only ?? o.initial.isReduceOnly ?? o.initial.is_reduce_only,
        is_reduce_only: o.initial.isReduceOnly ?? o.initial.is_reduce_only,
        auto_size: o.initial.autoSize ?? o.initial.auto_size,
        stopLoss: o.trigger?.rule === 2 ? o.initial.price : undefined,
        text: o.initial.text,
        trigger: o.trigger,
        initial: o.initial,
    };
}

export function mapTradeResult(t: any): Trade {
    return {
        id: t.id.toString(),
        orderId: t.orderId.toString(),
        symbol: t.contract,
        side: parseFloat(t.size) > 0 ? 'buy' : 'sell',
        price: t.price,
        amount: Math.abs(parseFloat(t.size)).toString(),
        role: t.role,
        time: t.createTime * 1000,
        text: t.text,
        fee: t.fee != null ? Math.abs(parseFloat(t.fee)).toString() : undefined,
        feeCurrency: t.feeCoin,
    };
}

// NOTE: SDK 反序列化后字段是 camelCase（entryPrice, markPrice, unrealisedPnl），
// 不是 API 原始的 snake_case（entry_price, mark_price, unrealised_pnl）。
// 参见 Position.attributeTypeMap: name='entryPrice' <-> baseName='entry_price'
export function mapPositionResult(p: any): Position {
    return {
        symbol: p.contract,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealisedPnl,
        leverage: p.leverage,
        marginType: p.mode === 'single' ? 'isolated' : 'cross'
    };
}

export function mapTickerResult(data: any): Ticker {
    return {
        symbol: data.contract,
        lastPrice: data.last,
        markPrice: data.markPrice,
        indexPrice: data.indexPrice,
        fundingRate: data.fundingRate,
        volume24h: data.volume24h,
        change24h: data.changePercentage
    };
}

export function mapCandleRow(row: any): Candle {
    return {
        timestamp: Number(row.t ?? row[0]) * 1000,
        open: String(row.o ?? row[5] ?? row.open),
        high: String(row.h ?? row[3] ?? row.high),
        low: String(row.l ?? row[4] ?? row.low),
        close: String(row.c ?? row[2] ?? row.close),
        volume: row.v != null ? String(row.v) : row[1] != null ? String(row[1]) : undefined,
    };
}

export function isScopedProtectionText(text: string): boolean {
    return text.includes('-ord-') || text.includes('-strategy-');
}

export function isPostOnlyImmediateMatchError(error: any): boolean {
    const message = error?.message || '';
    return message.includes('ORDER_POC_IMMEDIATE');
}
