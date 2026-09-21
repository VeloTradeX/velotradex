import { LighterMarketConfig } from './types';
import { symbolFromMarketKey } from './LighterSymbolUtils';

export function extractPositionRows(raw: unknown, markets: LighterMarketConfig[]): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Unrecognized Lighter account positions response');
  }

  const candidate = raw as {
    positions?: unknown;
    position?: unknown;
    account?: { positions?: unknown; position?: unknown };
    accounts?: Array<{ positions?: unknown; position?: unknown }>;
  };

  const positionContainers = [
    candidate.positions,
    candidate.position,
    candidate.account?.positions,
    candidate.account?.position,
    candidate.accounts?.[0]?.positions,
    candidate.accounts?.[0]?.position,
  ];

  for (const positions of positionContainers) {
    const rows = positionContainerToRows(positions, markets);
    if (rows) return rows;
  }

  throw new Error('Unrecognized Lighter account positions response');
}

function positionContainerToRows(positions: unknown, markets: LighterMarketConfig[]): unknown[] | undefined {
  if (Array.isArray(positions)) {
    return positions;
  }
  if (positions && typeof positions === 'object') {
    const row = positions as Record<string, unknown>;
    if ('position' in row || 'position_size' in row || 'positionSize' in row || 'market_id' in row || 'marketId' in row) {
      return [positions];
    }
    return positionMapToRows(row, markets);
  }

  return undefined;
}

function positionMapToRows(positions: Record<string, unknown>, markets: LighterMarketConfig[]): unknown[] {
  return Object.entries(positions).map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const row = value as Record<string, unknown>;
    return {
      symbol: row.symbol ?? symbolFromMarketKey(markets, key),
      market: row.market ?? key,
      ...row,
    };
  });
}

export function enrichPositionRow(position: unknown, markets: LighterMarketConfig[]): unknown {
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    return position;
  }

  const row = position as Record<string, unknown>;
  const marketKey = row.market_id ?? row.marketId ?? row.market_index ?? row.marketIndex ?? row.symbol ?? row.market;
  if (marketKey === undefined || marketKey === null) return row;

  return {
    ...row,
    symbol: symbolFromMarketKey(markets, String(marketKey)),
  };
}
