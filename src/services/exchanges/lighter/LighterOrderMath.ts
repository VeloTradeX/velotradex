import { Position } from '../IExchange';
import logger from '../../../utils/logger';
import { LighterMarketMap } from './LighterMarketMap';

export function formatAmountWithPrecision(value: number, precision: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (!Number.isInteger(precision) || precision <= 0) return Math.round(value).toString();
  const factor = 10 ** precision;
  const normalized = Math.floor(value * factor) / factor;
  return normalized.toFixed(precision).replace(/\.?0+$/, '');
}

export function isPositiveDecimalString(value: string | undefined): value is string {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  return BigInt(value.replace('.', '')) > 0n;
}

/**
 * 计算当前保证金支持的最大可开仓数量
 * @param symbol 交易对
 * @param side 方向
 * @param price 价格
 * @param leverage 杠杆倍数（由调用方传入，避免 getMarginMode 在无持仓时返回 '1'）
 * @param availableBalance 可用余额
 * @param position 当前持仓（可为 null）
 */
export function calculateMaxOpenAmount(
  marketMap: LighterMarketMap,
  symbol: string,
  side: 'buy' | 'sell',
  price: string,
  leverage: number,
  availableBalance: number,
  position: Position | null,
): string {
  const market = marketMap.resolve(symbol);
  const priceNum = parseFloat(price);
  if (!priceNum || priceNum <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(availableBalance) || availableBalance <= 0) {
    return '0';
  }

  // 反向持仓平仓释放的保证金：|positionSize| * entryPrice / leverage
  let releasedMargin = 0;
  if (position) {
    const positionSize = parseFloat(position.size);
    const isReverse = (side === 'buy' && positionSize < 0) || (side === 'sell' && positionSize > 0);
    if (isReverse) {
      const reverseSize = Math.abs(positionSize);
      const reverseEntryPrice = parseFloat(position.entryPrice);
      if (Number.isFinite(reverseEntryPrice) && reverseEntryPrice > 0) {
        releasedMargin = (reverseSize * reverseEntryPrice) / leverage;
      }
    }
  }

  // 可用于开新仓的保证金 = 原有可用余额 + 反向持仓释放的保证金
  const effectiveMargin = availableBalance + releasedMargin;
  // 最大可开仓数量 = 可用保证金 * 杠杆 * 0.9 / 价格
  const maxAmount = (effectiveMargin * leverage * 0.9) / priceNum;

  if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
    return '0';
  }

  const formattedAmount = formatAmountWithPrecision(maxAmount, market.sizeDecimals);
  logger.info(`[Lighter] Max open amount for ${symbol}: ${formattedAmount} (available: ${availableBalance}, leverage: ${leverage}, price: ${priceNum}, releasedMargin: ${releasedMargin.toFixed(4)})`);

  return formattedAmount;
}
