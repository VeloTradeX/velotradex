import exchangeRegistry from './exchanges';
import { normalizeBigInts } from '../utils/json';

interface OpenOrdersResult {
  openOrders: any[];
  triggerOrders: any[];
}

class OrderQueryService {
  async getOpenOrders(symbol?: string): Promise<OpenOrdersResult> {
    const exchanges = exchangeRegistry.getAllExchanges();
    const allOpen: any[] = [];
    const allTrigger: any[] = [];

    for (const exchange of exchanges) {
      try {
        const openOrders = await exchange.getOpenOrders(symbol);
        const triggerOrders = await exchange.getPriceOrders(symbol);

        allOpen.push(...openOrders.map(o => ({ ...o, exchangeInstanceId: exchange.id })));
        allTrigger.push(...triggerOrders.map(o => ({ ...o, exchangeInstanceId: exchange.id })));
      } catch (error: any) { /* ignore individual exchange errors */ }
    }

    return {
      openOrders: normalizeBigInts(allOpen),
      triggerOrders: normalizeBigInts(allTrigger)
    };
  }

  async getPositions(exchangeInstanceId?: any): Promise<any[]> {
    const allPositions: any[] = [];

    let exchanges = [];
    if (exchangeInstanceId) {
      try {
        const exchange = exchangeRegistry.getExchange(exchangeInstanceId as string);
        exchanges.push(exchange);
      } catch (e) {
        // invalid id
      }
    } else {
      exchanges = exchangeRegistry.getAllExchanges();
    }

    for (const exchange of exchanges) {
      try {
        const positions = await exchange.getPositions();
        const active = positions.filter(p => {
          const size = typeof p.size === 'number' ? p.size : parseFloat(String(p.size));
          return !isNaN(size) && size !== 0;
        });
        allPositions.push(...active.map(p => ({ ...p, exchangeInstanceId: exchange.id, exchangeName: exchange.name })));
      } catch (error: any) {
        // ignore
      }
    }
    return normalizeBigInts(allPositions);
  }
}

export default new OrderQueryService();