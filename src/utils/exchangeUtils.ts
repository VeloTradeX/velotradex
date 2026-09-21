/**
 * Check if an exchange instance is a Gate TradFi exchange.
 * Used by TradeExecutor, NoStopLossMonitor, and other services
 * that need exchange-type-specific branching.
 */
export function isTradFiExchange(exchange: any): boolean {
  if (!exchange) return false;
  return exchange.name === 'gate_tradfi' ||
    exchange.productLine === 'gate_cfd' ||
    exchange.constructor?.name === 'TradFiExchange' ||
    exchange.constructor?.name === 'GateCFDExchange';
}
