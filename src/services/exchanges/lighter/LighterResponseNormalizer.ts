import { AccountBalance, Candle, OrderResult, Ticker, Trade } from '../IExchange';
import { firstString } from '../../../utils/coalesceString';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coalesceString(...values: unknown[]): string {
  const value = values.find(v => v !== undefined && v !== null);
  return value != null ? String(value) : '0';
}

function normalizeOrderStatus(status: unknown): string {
  const upper = String(status ?? '').toUpperCase();
  if (upper === 'FILLED') return 'filled';
  if (upper.startsWith('CANCELED') || upper.startsWith('CANCELLED')) return 'cancelled';
  if (upper === 'REJECTED') return 'rejected';
  return 'open';
}

// Lighter order type codes (from lighter-go/txtypes/constants.go)
const LIGHTER_ORDER_TYPE_MAP: Record<number, string> = {
  0: 'LIMIT',
  1: 'MARKET',
  2: 'STOP_LOSS',
  3: 'STOP_LOSS_LIMIT',
  4: 'TAKE_PROFIT',
  5: 'TAKE_PROFIT_LIMIT',
};

function normalizeLighterOrderType(rawType: unknown): string {
  if (rawType === undefined || rawType === null) return '';
  const num = Number(rawType);
  if (Number.isFinite(num) && LIGHTER_ORDER_TYPE_MAP[num]) {
    return LIGHTER_ORDER_TYPE_MAP[num];
  }
  return String(rawType);
}

// ---------------------------------------------------------------------------
// Row extractors
// ---------------------------------------------------------------------------

function extractRows(
  raw: unknown,
  ...resourceNames: string[]
): unknown[] {
  // Top-level array
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Unrecognized Lighter ${resourceNames[0]} response`);
  }

  const obj = raw as Record<string, unknown>;

  // Nested: raw.orders / raw.trades / raw.candles / raw.data / ...
  for (const name of resourceNames) {
    if (Array.isArray(obj[name])) {
      return obj[name];
    }
    if (obj[name] && typeof obj[name] === 'object') {
      return flattenPayloadMap(obj[name] as Record<string, unknown>);
    }
  }

  // Nested: raw.data (generic wrapper)
  if (Array.isArray(obj.data)) {
    return obj.data;
  }

  throw new Error(`Unrecognized Lighter ${resourceNames[0]} response`);
}

function flattenPayloadMap(value: Record<string, unknown>): unknown[] {
  return Object.values(value).flatMap(item => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') return [item];
    return [];
  });
}

function extractSingle(
  raw: unknown,
  errorLabel: string,
  ...resourceNames: string[]
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Unrecognized Lighter ${errorLabel} response`);
  }

  const obj = raw as Record<string, unknown>;

  // Direct object (already the resource itself)
  // Check if it has recognizable fields for any of the resources
  for (const name of resourceNames) {
    if (obj[name] && typeof obj[name] === 'object' && !Array.isArray(obj[name])) {
      return obj[name] as Record<string, unknown>;
    }
  }

  // raw.data as object wrapper
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    return obj.data as Record<string, unknown>;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// normalizeLighterBalance
// ---------------------------------------------------------------------------

export function normalizeLighterBalance(
  raw: unknown,
  currency: string,
): AccountBalance {
  const account = extractAccountFromResponse(raw);

  return {
    currency,
    available: coalesceString(
      account.available_balance,
      account.availableBalance,
      account.available,
    ),
    total: coalesceString(
      account.collateral,
      account.total_balance,
      account.totalBalance,
      account.total,
    ),
    unrealizedPnl: firstString(
      account.unrealized_pnl,
      account.unrealizedPnl,
      account.pnl,
    ),
  };
}

function extractAccountFromResponse(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Unrecognized Lighter account balance response');
  }

  const obj = raw as Record<string, unknown>;

  // Official API: { code, total, accounts: [DetailedAccount] }
  if (Array.isArray(obj.accounts) && obj.accounts.length > 0) {
    return obj.accounts[0] as Record<string, unknown>;
  }

  // Fallback: direct account object or nested account
  return extractSingle(raw, 'account balance', 'account');
}

// ---------------------------------------------------------------------------
// normalizeLighterOrders
// ---------------------------------------------------------------------------

export function normalizeLighterOrders(
  raw: unknown,
  fallbackSymbol?: string,
): OrderResult[] {
  const rows = extractRows(raw, 'orders');

  return rows.map((row: any) => {
    const id = firstString(
      row.client_order_index,
      row.clientOrderIndex,
      row.order_id,
      row.orderId,
      row.id,
    ) ?? '';

    return {
      id,
      symbol: firstString(row.symbol, row.market) || fallbackSymbol || '',
      side: normalizeOrderSide(row),
      price: firstString(row.price, row.avg_price, row.avgPrice) ?? '',
      amount: firstString(
        row.base_amount,
        row.baseAmount,
        row.amount,
        row.size,
      ) ?? '',
      status: normalizeOrderStatus(row.status),
      type: normalizeLighterOrderType(row.order_type ?? row.orderType ?? row.type),
      text: firstString(row.text, row.message, row.client_order_index, row.clientOrderIndex),
      raw: row,
    };
  });
}

function normalizeOrderSide(row: any): string {
  const side = firstString(row.side);
  if (side) return side;

  const isAsk = row.is_ask ?? row.isAsk;
  if (isAsk === true || isAsk === 1 || isAsk === 'true' || isAsk === '1') {
    return 'sell';
  }
  if (isAsk === false || isAsk === 0 || isAsk === 'false' || isAsk === '0') {
    return 'buy';
  }

  return '';
}

// ---------------------------------------------------------------------------
// normalizeLighterTrades
// ---------------------------------------------------------------------------

export function normalizeLighterTrades(
  raw: unknown,
  fallbackSymbol: string,
): Trade[] {
  const rows = extractRows(raw, 'trades');

  return rows.map((row: any) => {
    const isMaker = row.is_maker ?? row.isMaker;
    const role: 'maker' | 'taker' = isMaker === true || isMaker === 1
      ? 'maker'
      : 'taker';

    return {
      id: firstString(row.trade_id, row.tradeId, row.id) ?? '',
      orderId: firstString(
        row.client_order_index,
        row.clientOrderIndex,
        row.order_id,
        row.orderId,
      ) ?? '',
      symbol: firstString(row.symbol, row.market) || fallbackSymbol,
      side: (firstString(row.side) ?? '') as 'buy' | 'sell',
      price: firstString(row.price, row.avg_price, row.avgPrice) ?? '',
      amount: firstString(
        row.base_amount,
        row.baseAmount,
        row.amount,
        row.size,
      ) ?? '',
      role,
      time: Number(
        firstString(
          row.created_at,
          row.createdAt,
          row.timestamp,
          row.time,
        ) ?? '0',
      ),
      text: firstString(row.text, row.message),
      fee: firstString(
        row.fee,
        row.feeAmount,
        row.fee_amount,
        row.taker_fee,
        row.takerFee,
        row.maker_fee,
        row.makerFee,
        row.fees,
      ),
      feeCurrency: firstString(row.fee_coin, row.feeCoin, row.quote_coin, 'USDT'),
    };
  });
}

// ---------------------------------------------------------------------------
// normalizeLighterTicker
// ---------------------------------------------------------------------------

export function normalizeLighterTicker(
  raw: unknown,
  symbol: string,
): Ticker {
  const ticker = extractLighterTicker(raw);
  const publicLastPrice = firstString(ticker.last_trade_price, ticker.lastTradePrice);

  return {
    symbol,
    lastPrice: coalesceString(
      ticker.last_price,
      ticker.lastPrice,
      ticker.last,
      publicLastPrice,
    ),
    markPrice: coalesceString(
      ticker.mark_price,
      ticker.markPrice,
      ticker.mark,
      publicLastPrice,
    ),
    indexPrice: coalesceString(
      ticker.index_price,
      ticker.indexPrice,
      ticker.index,
      publicLastPrice,
    ),
    fundingRate: coalesceString(
      ticker.funding_rate,
      ticker.fundingRate,
      ticker.funding,
    ),
    volume24h: coalesceString(
      ticker.volume_24h,
      ticker.volume24h,
      ticker.volume,
      ticker.daily_base_token_volume,
      ticker.dailyBaseTokenVolume,
    ),
    change24h: coalesceString(
      ticker.price_change_24h,
      ticker.priceChange24h,
      ticker.change24h,
      ticker.change,
      ticker.daily_price_change,
      ticker.dailyPriceChange,
    ),
  };
}

function extractLighterTicker(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Unrecognized Lighter ticker response');
  }

  const obj = raw as Record<string, unknown>;
  const orderBookDetails = obj.order_book_details ?? obj.orderBookDetails;
  if (Array.isArray(orderBookDetails)) {
    const first = orderBookDetails[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return first as Record<string, unknown>;
    }
  }

  return extractSingle(raw, 'ticker', 'ticker');
}

// ---------------------------------------------------------------------------
// normalizeLighterCandles
// ---------------------------------------------------------------------------

export function normalizeLighterCandles(
  raw: unknown,
): Candle[] {
  const rows = extractRows(raw, 'candles', 'c');

  return rows.map((row: any) => ({
    timestamp: Number(
      firstString(row.time, row.timestamp, row.t) ?? '0',
    ),
    open: coalesceString(row.open, row.o),
    high: coalesceString(row.high, row.h),
    low: coalesceString(row.low, row.l),
    close: coalesceString(row.close, row.c),
    volume: firstString(row.volume, row.v),
  }));
}
