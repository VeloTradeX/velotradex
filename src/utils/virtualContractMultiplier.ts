import fs from 'fs';
import path from 'path';

import { normalizeSymbolCase } from './normalizeSymbol';

let futuresMultiplierCache: Map<string, number> | null = null;
let cfdVolumeCache: Map<string, number> | null = null;

const loadGateContractMultipliers = (): Map<string, number> => {
  if (futuresMultiplierCache) return futuresMultiplierCache;

  const multipliers = new Map<string, number>();
  const dictPath = path.join(process.cwd(), 'dict', 'gate_contracts.json');
  try {
    const contracts = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
    if (Array.isArray(contracts)) {
      for (const contract of contracts) {
        const symbol = typeof contract?.name === 'string' ? normalizeSymbolCase(contract.name) : '';
        const multiplier = Number(contract?.quanto_multiplier);
        if (symbol.endsWith('_USDT') && Number.isFinite(multiplier) && multiplier > 0) {
          multipliers.set(symbol, multiplier);
        }
      }
    }
  } catch {
    // Fall back to common contract multipliers below.
  }

  futuresMultiplierCache = multipliers;
  return multipliers;
};

/**
 * Gate-CFD（tradfi）品种的每手合约数量（contractVolume），如 XAU_USDT = 100（0.01 手 = 1 XAU）。
 * 与 VirtualGateTradFiExchange / GateCFDMapper 的 multiplier（= contractVolume）保持一致，
 * 只收录内部 BASE_USDT 形态的条目，避免与合约（quanto_multiplier）语义混淆。
 */
const loadCfdContractVolumes = (): Map<string, number> => {
  if (cfdVolumeCache) return cfdVolumeCache;

  const volumes = new Map<string, number>();
  const dictPath = path.join(process.cwd(), 'dict', 'gate_cfd_symbols.json');
  try {
    const raw = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
    const symbols: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.symbols) ? raw.symbols : [];
    for (const item of symbols) {
      const rawSymbol = typeof item?.symbol === 'string' ? item.symbol : '';
      if (!rawSymbol.includes('_USDT')) continue;
      const symbol = normalizeSymbolCase(rawSymbol);
      const volume = Number(item?.contractVolume);
      if (Number.isFinite(volume) && volume > 0 && !volumes.has(symbol)) {
        volumes.set(symbol, volume);
      }
    }
  } catch {
    // 字典缺失时按下方兜底逻辑处理。
  }

  cfdVolumeCache = volumes;
  return volumes;
};

export const getVirtualContractMultiplier = (symbol: string): number => {
  const normalized = normalizeSymbolCase(symbol);
  const futuresMultiplier = loadGateContractMultipliers().get(normalized);
  if (futuresMultiplier) return futuresMultiplier;

  // 贵金属/外汇等 Gate-CFD 品种（如 XAU_USDT）不在合约字典中，按每手合约数量换算
  const cfdVolume = loadCfdContractVolumes().get(normalized);
  if (cfdVolume) return cfdVolume;

  const base = normalized.split('_')[0];
  if (base === 'BTC') return 0.0001;
  if (base === 'ETH') return 0.01;
  return 1;
};
