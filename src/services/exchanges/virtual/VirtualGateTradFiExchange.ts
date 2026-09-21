/**
 * VirtualGateTradFiExchange —— 虚拟 Gate TradFi 交易所（虚拟撮合，行情源自 Gate TradFi）。
 *
 * 仿照现有 VirtualGateExchange 的虚拟交易所机制（虚拟账户 / 虚拟持仓 / 虚拟订单 /
 * 虚拟撮合），与后者的本质区别仅在行情与品种来源：
 * - 行情源：Gate TradFi 公共行情（wss://fx-ws.gateio.ws/v4/ws/tradfi，
 *   GateTradFiMarketDataStream 经 GateTradFiStreamAdapter 桥接进 MarketDataHub）；
 * - 品种表：读取 dict/gate_cfd_symbols.json（Gate-CFD 品种规格兜底字典），
 *   抽取其中系统内部符号（BASE_USDT，如 XAU_USDT），其余全部复用父类逻辑。
 *
 * 下单选价 / 成交 / 持仓盈亏 / 余额计算等虚拟撮合逻辑完全继承 VirtualGateExchange，
 * 不做任何实盘接口调用，属于纯模拟盘。
 */
import { MarketInfo } from '../IExchange';
import { VirtualGateExchange } from './VirtualGateExchange';
import fs from 'fs';
import path from 'path';
import { normalizeSymbolCase } from '../../../utils/normalizeSymbol';
import { toTradFiSymbol, fromTradFiSymbol } from '../gate_cfd/cfdSymbol';

export class VirtualGateTradFiExchange extends VirtualGateExchange {
  getWebSocketStats(): any {
    return { isConnected: true, type: 'virtual_gate_tradfi' };
  }

  /** 品种表覆盖：从 dict/gate_cfd_symbols.json 抽取内部 BASE_USDT 符号（如 XAU_USDT） */
  protected getMarketList(): MarketInfo[] {
    if (this.marketsCache) return this.marketsCache;

    const dictPath = path.join(process.cwd(), 'dict', 'gate_cfd_symbols.json');
    const markets: MarketInfo[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
      const symbols: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.symbols) ? raw.symbols : [];
      const seen = new Set<string>();
      for (const item of symbols) {
        const rawSymbol = typeof item?.symbol === 'string' ? item.symbol : '';
        if (!rawSymbol || rawSymbol.startsWith('_')) continue;
        // 只保留能映射为系统内部 BASE_USDT 符号、且可反向映射回 tradfi 订阅的品种
        const internal = rawSymbol.includes('_USDT')
          ? normalizeSymbolCase(rawSymbol)
          : fromTradFiSymbol(rawSymbol);
        if (!internal || !internal.includes('_USDT')) continue;
        const tradfi = toTradFiSymbol(internal);
        if (!tradfi || seen.has(internal)) continue;
        seen.add(internal);

        const volume = Number(item?.contractVolume);
        const multiplier = Number.isFinite(volume) && volume > 0 ? String(volume) : '1';
        const precision = Number.isFinite(Number(item?.pricePrecision)) ? Number(item.pricePrecision) : 2;
        markets.push(this.market(internal, internal.split('_')[0], 'USDT', multiplier, precision, 2));
      }
    } catch (error: any) {
      console.warn(`[VirtualGateTradFiExchange] Failed to load Gate-CFD symbol dictionary from ${dictPath}: ${error?.message ?? error}`);
    }

    if (markets.length === 0) {
      // 兜底：字典缺失时提供最小可交易品种（多：XAU_USDT，空：BTC_USDT/ETH_USDT）
      markets.push(
        this.market('XAU_USDT', 'XAU', 'USDT', '100', 2, 2),
        this.market('BTC_USDT', 'BTC', 'USDT', '1', 2, 2),
        this.market('ETH_USDT', 'ETH', 'USDT', '1', 2, 2),
      );
    }

    this.marketsCache = markets;
    return markets;
  }
}