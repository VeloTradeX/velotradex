import { Order, SignalRoute, Strategy } from '../models';
import exchangeRegistry from './exchanges';
import logger, { formatError } from '../utils/logger';
import { Op } from 'sequelize';

class TradingStatsService {
  private getContractMultiplier(order: any, entry: number, exit: number, contracts: number, pnl: number) {
    const isFiniteNumber = (value: number) => Number.isFinite(value) && value > 0;
    const isLong = order.side === 'buy';
    const rawDiff = isLong ? (exit - entry) : (entry - exit);

    if (isFiniteNumber(rawDiff) && isFiniteNumber(contracts) && Number.isFinite(pnl) && pnl !== 0) {
      const inferred = Math.abs(pnl / (rawDiff * contracts));
      if (isFiniteNumber(inferred)) return inferred;
    }

    const symbol = String(order.symbol || '').toUpperCase();
    if (symbol.includes('BTC')) return 0.0001;
    if (symbol.includes('ETH')) return 0.01;
    return 1;
  }

  private getRouteMatch(strategy: any, routeId: number, exchangeInstanceId?: string) {
    if (!strategy?.routes) return false;

    try {
      const routes = JSON.parse(strategy.routes);
      if (!Array.isArray(routes)) return false;

      return routes.some((item: any) => {
        if (Number(item?.routeId) !== routeId) return false;
        if (exchangeInstanceId && item?.exchangeInstanceId && item.exchangeInstanceId !== exchangeInstanceId) {
          return false;
        }
        return true;
      });
    } catch (error) {
      logger.warn('Failed to parse strategy routes for trading stats', {
        strategyId: strategy?.id,
        error
      });
      return false;
    }
  }
  
  public async recordOrderStats(orderId: number, exitPriceStr: string, exitTime: Date, exitFee = 0) {
    try {
        const order = await Order.findByPk(orderId);
        if (!order) return;

        // Skip if already recorded
        if (order.realizedPnl) return;

        const exchange = exchangeRegistry.getExchange(order.exchangeInstanceId);
        let multiplier = 1.0;
        
        try {
            const markets = await exchange.getMarkets();
            const market = markets.find(m => m.symbol === order.symbol);
            if (market && market.multiplier) {
                multiplier = parseFloat(market.multiplier);
            } else {
                // Fallback for common pairs if market info missing?
                // Or just default to 1 (Spot-like) or 0.0001 (BTC-like)?
                // Safest is 1 if we treat amount as "Quantity" but we know it's contracts.
                // Let's check symbol.
                if (order.symbol.includes('BTC')) multiplier = 0.0001;
                else if (order.symbol.includes('ETH')) multiplier = 0.01;
            }
        } catch (e) {
            logger.warn('Failed to fetch market info for stats, using default multiplier');
        }

        const entry = parseFloat(order.filledPrice || order.price || '0');
        const exit = parseFloat(exitPriceStr);
        const contracts = parseFloat(order.amount || '0');
        
        if (entry === 0 || contracts === 0) {
            logger.warn(`Cannot calc PnL for order ${orderId}: Entry/Amount is 0`);
            return;
        }

        const isLong = order.side === 'buy';
        // PnL = (Exit - Entry) * Contracts * Multiplier (Long)
        // PnL = (Entry - Exit) * Contracts * Multiplier (Short)
        const rawDiff = isLong ? (exit - entry) : (entry - exit);
        const grossPnL = rawDiff * contracts * multiplier;
        // 手续费计入：realizedPnl 扣除手续费得到净盈亏（当前计入平仓侧成交手续费）。
        const fee = (Number.isFinite(exitFee) && exitFee > 0) ? exitFee : 0;
        const realizedPnL = grossPnL - fee;

        // Slippage Calculation
        // Slippage = (FillPrice - ExpectedPrice) / ExpectedPrice
        // Note: order.price is usually the Strategy Entry Price or Limit Price.
        // order.filledPrice is the actual Fill Price (entry).
        // Wait, stats are recorded at EXIT.
        // Slippage usually refers to Entry Slippage or Exit Slippage.
        // User asked for: slippage = (FillPrice - EntryPrice) / EntryPrice.
        // This implies Entry Slippage if FillPrice is Entry Fill and EntryPrice is Strategy Entry.
        // BUT recordOrderStats is called at EXIT.
        // However, we can calc Entry Slippage here if we have Strategy Entry Price.
        // Order model has `price` (Strategy/Limit) and `filledPrice` (Actual Entry).
        
        let slippage = 0;
        const expectedEntry = parseFloat(order.price || '0');
        const actualEntry = parseFloat(order.filledPrice || '0');
        
        if (expectedEntry > 0 && actualEntry > 0) {
            // Slippage %
            // For Long: Positive if Actual > Expected (Bad)
            // For Short: Positive if Actual < Expected (Bad) -> Wait, usually Slippage is just Price Diff %
            // User formula: (Fill - Entry) / Entry.
            // If Long: (101 - 100) / 100 = 1% (Bad).
            // If Short: (99 - 100) / 100 = -1% (Good? No, Short selling lower is bad).
            // Let's stick to standard: |Actual - Expected| / Expected ? 
            // User specifically said: (FillPrice - EntryPrice) / EntryPrice.
            // Let's store exactly that.
            slippage = (actualEntry - expectedEntry) / expectedEntry;
        }

        let rValue = 0;
        if (order.initialSl) {
            const sl = parseFloat(order.initialSl);
            // Risk is always positive distance
            const riskPerUnit = Math.abs(entry - sl);
            if (riskPerUnit > 0) {
                // R = RawDiff / RiskPerUnit
                rValue = rawDiff / riskPerUnit;
            }
        }

        order.realizedPnl = realizedPnL.toFixed(4);
        order.fees = fee > 0 ? fee.toFixed(6) : '0';
        order.mathMultiplier = String(multiplier);
        order.exitPrice = exitPriceStr;
        order.closedAt = exitTime;
        // Save R value? Order doesn't have rValue field. 
        // We can calc it on the fly or add it. 
        // User asked for "Total R value".
        // I should probably add `rValue` to Order model too for efficiency?
        // But I didn't add it in the previous step. 
        // I can use `realizedPnl` and `initialSl` to reverse calc, or just store it.
        // Let's calculate on the fly in getStats to avoid another DB migration risk right now.
        
        await order.save();
        
        logger.info(`Stats recorded for order ${orderId}: PnL=${order.realizedPnl}, R=${rValue.toFixed(4)}, Slippage=${(slippage * 100).toFixed(4)}%`);
    } catch (error: any) {
        logger.error(`Failed to record stats for order ${orderId}`, formatError(error));
    }
  }

  public async getStats(days: number, routeId?: number, backtestRunId?: number) {
      const isBacktest = Number.isFinite(backtestRunId);

      const where: any = {
          lifecycleStatus: 'CLOSED',
          realizedPnl: { [Op.not]: null }
      };

      if (isBacktest) {
          // 指定回测：直接按 run 过滤，closedAt 为历史时间（K线触发时间），
          // 不套用「近 N 天」实盘窗口
          where.backtestRunId = backtestRunId;
      } else {
          // 实盘统计：默认排除回测导入的订单
          where.backtestRunId = { [Op.is]: null };
          const now = new Date();
          const startDate = new Date();
          startDate.setDate(now.getDate() - days);
          where.closedAt = { [Op.gte]: startDate };
      }

      let route: any = null;
      if (routeId && !isBacktest) {
          try {
              route = await SignalRoute.findByPk(routeId);
              if (route) {
                  where.exchangeInstanceId = route.exchangeInstanceId;
              } else {
                  return [];
              }
          } catch (e) {
              logger.warn(`Failed to fetch route ${routeId} for stats filtering`, { error: e });
              return [];
          }
      }

      const orders = await Order.findAll({
          where,
          include: [{
              model: Strategy,
              as: 'Strategy',
              attributes: ['id', 'source', 'routes'],
              required: false
          }],
          order: [['closedAt', 'ASC']]
      });

      const statsBySource: Record<string, any> = {};

      for (const order of orders) {
          const strategy = (order as any).Strategy;
          const effectiveSource = order.source || strategy?.source || 'Unknown';

          if (routeId && !isBacktest) {
              const sourceMatches = effectiveSource === route?.channelId;
              const routeMatches = Number((order as any).routeId) === routeId
                || this.getRouteMatch(strategy, routeId, order.exchangeInstanceId);
              if (!sourceMatches || !routeMatches) continue;
          }

          const source = effectiveSource;
          if (!statsBySource[source]) {
              statsBySource[source] = {
                  totalOrders: 0,
                  wins: 0,
                  losses: 0,
                  neutral: 0,
                  sumWinPnL: 0,
                  sumLossPnL: 0,
                  totalPnL: 0,
                  totalFees: 0,
                  totalR: 0,
                  totalRoi: 0,
                  totalMargin: 0,
                  history: {}
              };
          }

          const s = statsBySource[source];
          s.totalOrders++;
          
          const pnl = parseFloat(order.realizedPnl || '0');
          s.totalPnL += pnl;
          // 累加手续费（净盈亏已扣除，此处仅用于单独展示）
          s.totalFees += parseFloat(order.fees || '0');

          if (pnl > 0) {
              s.wins++;
              s.sumWinPnL += pnl;
          } else if (pnl < 0) {
              s.losses++;
              s.sumLossPnL += Math.abs(pnl);
          } else {
              s.neutral++;
          }

          const entry = parseFloat(order.filledPrice || order.price || '0');
          const exit = parseFloat(order.exitPrice || '0');
          const contracts = parseFloat(order.filledAmount || order.amount || '0');
          const leverage = Math.max(parseFloat(order.leverage || '0') || 0, 1);
          let r = 0;
          if (order.initialSl && entry > 0 && exit > 0) {
              const sl = parseFloat(order.initialSl);
              const risk = Math.abs(entry - sl);
              const isLong = order.side === 'buy';
              const rawDiff = isLong ? (exit - entry) : (entry - exit);
              if (risk > 0) r = rawDiff / risk;
          }
          s.totalR += r;

          // 优先使用记录订单时落库的合约乘数，避免用手续费后的 realizedPnl 反推产生偏差
          const multiplier = order.mathMultiplier
            ? parseFloat(order.mathMultiplier)
            : this.getContractMultiplier(order, entry, exit, contracts, pnl);
          const margin = entry > 0 && contracts > 0 ? (entry * contracts * multiplier) / leverage : 0;
          s.totalMargin += margin;

          const date = new Date(order.closedAt);
          const bucket = date.toISOString().split('T')[0];

          if (!s.history[bucket]) {
              s.history[bucket] = { pnl: 0, r: 0, roi: 0, margin: 0, count: 0 };
          }
          s.history[bucket].pnl += pnl;
          s.history[bucket].r += r;
          s.history[bucket].margin += margin;
          s.history[bucket].count++;
      }

      return Object.keys(statsBySource).map(source => {
          const s = statsBySource[source];
          const decisiveTrades = s.wins + s.losses;
          const winRate = decisiveTrades > 0 ? (s.wins / decisiveTrades) : 0;
          const avgWin = s.wins > 0 ? (s.sumWinPnL / s.wins) : 0;
          const avgLoss = s.losses > 0 ? (s.sumLossPnL / s.losses) : 0;
          const pnlRatio = avgLoss > 0 ? (avgWin / avgLoss) : (s.wins > 0 ? null : 0);
          const history = Object.fromEntries(
              Object.entries(s.history).map(([date, bucket]: [string, any]) => [
                  date,
                  {
                      ...bucket,
                      roi: bucket.margin > 0 ? (bucket.pnl / bucket.margin) * 100 : 0
                  }
              ])
          );

          return {
              source,
              totalOrders: s.totalOrders,
              wins: s.wins,
              losses: s.losses,
              neutral: s.neutral,
              sumWinPnL: s.sumWinPnL,
              sumLossPnL: s.sumLossPnL,
              winRate, // 0-1
              pnlRatio,
              totalPnL: s.totalPnL,
              totalFees: s.totalFees,
              totalR: s.totalR,
              totalRoi: s.totalMargin > 0 ? (s.totalPnL / s.totalMargin) * 100 : 0,
              totalMargin: s.totalMargin,
              history,
          };
      });
  }
}

export default new TradingStatsService();
