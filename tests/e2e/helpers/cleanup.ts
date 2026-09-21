import { IExchange } from '../../../src/services/exchanges/IExchange';

const CLEANUP_TIMEOUT_MS = 30_000;
const CLEANUP_POLL_MS = 2_000;

async function waitForClean(exchange: IExchange, symbol: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let lastOpenOrders: any[] = [];
  let lastPriceOrders: any[] = [];
  let lastPosition: any = null;

  while (Date.now() < deadline) {
    lastOpenOrders = await exchange.getOpenOrders(symbol);
    lastPriceOrders = await exchange.getPriceOrders(symbol);
    lastPosition = await exchange.getPosition(symbol);

    if (lastOpenOrders.length === 0 && lastPriceOrders.length === 0 && (!lastPosition || parseFloat(lastPosition.size) === 0)) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, CLEANUP_POLL_MS));
  }

  if (lastOpenOrders.length > 0) {
    throw new Error(
      `[verifyClean] expected 0 open orders for ${symbol}, found ${lastOpenOrders.length}: `
      + lastOpenOrders.map((o) => o.id).join(', '),
    );
  }

  if (lastPriceOrders.length > 0) {
    throw new Error(
      `[verifyClean] expected 0 price/trigger orders for ${symbol}, found ${lastPriceOrders.length}: `
      + lastPriceOrders.map((o) => o.id).join(', '),
    );
  }

  if (lastPosition && parseFloat(lastPosition.size) !== 0) {
    throw new Error(
      `[verifyClean] expected flat position (size=0) for ${symbol}, got size=${lastPosition.size}`,
    );
  }
}

/**
 * Cancel all open orders, TP/SL trigger orders, and close any open position.
 * Logs every action with a `[cleanup]` prefix.
 * Throws if closePosition fails — callers should let test failures surface.
 */
export async function cleanup(exchange: IExchange, symbol: string): Promise<void> {
  // Cancel open orders
  const openOrders = await exchange.getOpenOrders(symbol);
  for (const order of openOrders) {
    const ok = await exchange.cancelOrder(order.id, symbol);
    console.log(`[cleanup] cancelled open order ${order.id} (success=${ok})`);
  }

  // Cancel TP/SL trigger orders
  const priceOrders = await exchange.getPriceOrders(symbol);
  for (const order of priceOrders) {
    const ok = await exchange.cancelPriceOrder(order.id, symbol);
    console.log(`[cleanup] cancelled price order ${order.id} (success=${ok})`);
  }

  // Close open position if any
  const position = await exchange.getPosition(symbol);
  if (position && parseFloat(position.size) !== 0) {
    const sizeNum = parseFloat(position.size);
    const side: 'buy' | 'sell' = sizeNum > 0 ? 'sell' : 'buy';
    const ok = await exchange.closePosition(symbol, side);
    console.log(`[cleanup] closed position (size=${position.size}, side=${side}, success=${ok})`);
    if (!ok) {
      throw new Error(
        `[cleanup] closePosition failed for symbol=${symbol} side=${side} — `
        + `expected close to succeed; aborting to prevent state leakage`,
      );
    }
  }

  await waitForClean(exchange, symbol);
}

/**
 * Assert that the symbol is in a clean state: no open orders, no price/trigger orders,
 * and a flat position. Throws a descriptive error if any invariant is violated.
 */
export async function verifyClean(exchange: IExchange, symbol: string): Promise<void> {
  await waitForClean(exchange, symbol);
}
