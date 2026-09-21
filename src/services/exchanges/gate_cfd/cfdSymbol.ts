/**
 * Gate-CFD（/tradfi/*）品种符号转换工具（纯函数，REST/WS 统一复用）。
 *
 * 系统内部统一使用 BASE_USDT 符号（如 XAU_USDT，与解析器 / MarketService /
 * 虚拟撮合一致），而 Gate /tradfi/* 接口（REST 与 WS 公共频道）使用 BASEUSD
 * 符号（如 XAUUSD）。本模块在这两种表示之间做转换，转换对各自输入幂等
 * （对已是目标格式的输入不做改动），可安全叠加调用。
 */
import { normalizeSymbolCase } from '../../../utils/normalizeSymbol';

/** tradfi 符号 → 内部符号的显式映射（处理 XAUUSD→XAU_USDT 这类插入下划线的品种） */
const TRADFI_TO_INTERNAL_OVERRIDES: Record<string, string> = {
  XAUUSD: 'XAU_USDT',
  XAGUSD: 'XAG_USDT',
  BTCUSD: 'BTC_USDT',
  ETHUSD: 'ETH_USDT',
};

/**
 * 内部符号（BASE_USDT）→ Gate-CFD/tradfi 符号（BASEUSD），如 XAU_USDT → XAUUSD。
 * 幂等：对已是 BASEUSD 的输入（如 XAUUSD）不做改动。
 */
export function toTradFiSymbol(symbol: string): string {
  return normalizeSymbolCase(symbol).replace(/[/_]?(USDT|USDC)$/, 'USD');
}

/**
 * Gate-CFD/tradfi 符号 → 内部符号（BASE_USDT），如 XAUUSD → XAU_USDT。
 * 幂等：对已是 BASE_USDT 的输入（如 XAU_USDT）不做改动。
 */
export function fromTradFiSymbol(symbol: string): string {
  const s = normalizeSymbolCase(symbol);
  if (TRADFI_TO_INTERNAL_OVERRIDES[s]) return TRADFI_TO_INTERNAL_OVERRIDES[s];
  if (s.endsWith('USD') && s.length > 3) {
    return `${s.slice(0, -3)}_USDT`;
  }
  return s;
}