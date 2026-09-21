import type { ParsedStrategy } from './parsers/types';
import type { AIAnalysisResult } from './AIParserService';

export function normalizeRouteSymbol(input: any): string {
  const raw = String(input || '').trim().toUpperCase().replace('/', '_');
  if (!raw) return '';
  if (raw.endsWith('_USDT')) return raw;
  if (raw.endsWith('USDT')) {
    const base = raw.slice(0, -4).replace(/_+$/, '');
    return `${base}_USDT`;
  }
  // 与 cfdSymbol.fromTradFiSymbol 的内部符号约定一致：
  // - USD 报价品种（XAUUSD/EURUSD/GBPUSD 等）→ BASE_USDT（如 XAUUSD → XAU_USDT）；
  // - 非 USD 报价外汇对（USDJPY/USDCNH/GBPJPY 等）内部符号直接用交易所原名，不加 _USDT
  //   （加后缀会破坏符号转换链：USDJPY_USDT → toTradFiSymbol → USDJPYUSD，交易所不存在）。
  if (raw.endsWith('USD') && raw.length > 3) {
    return `${raw.slice(0, -3)}_USDT`;
  }
  return raw;
}

export function applyAIResultToParsedStrategy(
  parsed: ParsedStrategy,
  aiResult: AIAnalysisResult
): ParsedStrategy {
  const routeParsed: ParsedStrategy = {
    ...parsed,
    symbol: normalizeRouteSymbol(parsed.symbol),
  };

  if (aiResult.action !== 'ignore') routeParsed.action = aiResult.action;
  routeParsed.symbol = normalizeRouteSymbol(aiResult.symbol);
  if (aiResult.side) routeParsed.side = aiResult.side;
  if (aiResult.entryPrice !== undefined && aiResult.entryPrice !== null) {
    routeParsed.entryPrice = String(aiResult.entryPrice);
  }
  if (aiResult.targets) routeParsed.targets = aiResult.targets.map((x) => String(x));
  if (aiResult.stopLoss !== undefined && aiResult.stopLoss !== null) {
    routeParsed.stopLoss = String(aiResult.stopLoss);
  }
  if (aiResult.leverage !== undefined && aiResult.leverage !== null) {
    routeParsed.leverage = String(aiResult.leverage);
  }
  if (aiResult.orderType === 'market' || aiResult.orderType === 'limit') {
    routeParsed.orderType = aiResult.orderType;
  }
  if (aiResult.closePercentage !== undefined && aiResult.closePercentage !== null) {
    const closePercentage = Number(aiResult.closePercentage);
    if (Number.isFinite(closePercentage)) {
      routeParsed.closePercentage = Math.max(0, Math.min(100, closePercentage));
    }
  }
  if (aiResult.closePrice !== undefined && aiResult.closePrice !== null) {
    routeParsed.closePrice = String(aiResult.closePrice);
  }
  if (aiResult.riskMultiplier !== undefined && aiResult.riskMultiplier !== null) {
    const riskMultiplier = Number(aiResult.riskMultiplier);
    if (Number.isFinite(riskMultiplier)) {
      routeParsed.riskMultiplier = riskMultiplier;
    }
  }

  return routeParsed;
}
