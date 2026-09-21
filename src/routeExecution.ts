import logger, { logContext, formatError } from './utils/logger';
import { Order } from './models';
import exchangeRegistry from './services/exchanges';
import tradeExecutor from './services/TradeExecutor';
import parserConfigService from './services/ParserConfigService';
import auditService from './services/AuditService';
import strategyDedupService from './services/StrategyDeduplicationService';
import config from './config';
import { AIAnalysisResult } from './services/AIParserService';
import { applyAIResultToParsedStrategy, normalizeRouteSymbol } from './services/RouteParsedStrategy';
import { applyEntrySelection } from './services/EntrySelection';
import { createStageDebug } from './utils/debug';
import { nowOrSim } from './backtest/Clock';
import { MIN_AI_CONFIDENCE, routeDisplayName, routeLogMessage, summarizeParsedStrategy, summarizeRoute } from './messageHelpers';

const debugRouting = createStageDebug('routing');
const debugOrder = createStageDebug('order');

export interface RouteExecutionContext {
  strategy: any;
  parsed: any;
  route: any;
  source: string;
  parserName: string;
  parser: any;
  parserHasBuiltInAI: boolean;
  sharedAIResult: AIAnalysisResult | null;
  getAIResult: () => Promise<AIAnalysisResult | null>;
}

export async function executeRouteForStrategy(ctx: RouteExecutionContext) {
  const { strategy, parsed, route, source, parserName, parser, parserHasBuiltInAI, sharedAIResult, getAIResult } = ctx;
  const exchangeInstanceId = route.exchangeInstanceId;
  const routeId = (route as any).id;
  // Update log context with route info
  const store = logContext.getStore();
  if (store) {
    const current = store.get('context') || {};
    store.set('context', { ...current, routeId, exchangeInstanceId });
  }
  const routeName = routeDisplayName(route);
  const aiMode = (route as any).aiMode || 'disabled';
  let exchangeName = 'Unknown';
  let routeParsed: any = { ...parsed, symbol: normalizeRouteSymbol(parsed.symbol) };
  debugRouting('route processing started %o', {
    strategyId: strategy.id,
    route: summarizeRoute(route),
    initialParsed: summarizeParsedStrategy(routeParsed),
  });

  try {
    const exchange = exchangeRegistry.getExchange(exchangeInstanceId);
    exchangeName = exchange.name;
  } catch (e) {
    logger.warn(routeLogMessage(routeName, `Exchange instance ${exchangeInstanceId} not found for route, skipping.`), { routeName, exchangeInstanceId });
    debugRouting('route skipped because exchange missing %o', {
      strategyId: strategy.id,
      routeId,
      exchangeInstanceId,
    });
    return {
      routeId,
      exchangeInstanceId,
      status: 'error',
      error: 'Exchange not found'
    };
  }

  try {
    if (aiMode === 'enabled' && !parserHasBuiltInAI) {
      const aiResult = sharedAIResult || await getAIResult();
      if (!aiResult) {
        await auditService.log(strategy.id, 'STRATEGY_FILTERED', {
          routeId,
          exchangeInstanceId,
          reason: 'AI required but no result returned'
        }, undefined, undefined, exchangeInstanceId, routeId);
        debugRouting('route filtered by ai missing result %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
        });
        return {
          routeId,
          exchangeInstanceId,
          exchangeName,
          status: 'filtered',
          reason: 'AI required but no result returned'
        };
      }

      if (aiResult.action === 'ignore') {
        await auditService.log(strategy.id, 'STRATEGY_FILTERED', {
          routeId,
          exchangeInstanceId,
          reason: 'AI marked signal as ignore'
        }, undefined, undefined, exchangeInstanceId, routeId);
        debugRouting('route filtered by ai ignore %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          aiResult,
        });
        return {
          routeId,
          exchangeInstanceId,
          exchangeName,
          status: 'filtered',
          reason: 'AI marked signal as ignore'
        };
      }

      const confidence = typeof aiResult.confidence === 'number' ? aiResult.confidence : 0;
      if (confidence < MIN_AI_CONFIDENCE) {
        await auditService.log(strategy.id, 'STRATEGY_FILTERED', {
          routeId,
          exchangeInstanceId,
          reason: `AI confidence too low (${confidence.toFixed(2)} < ${MIN_AI_CONFIDENCE})`
        }, undefined, undefined, exchangeInstanceId, routeId);
        debugRouting('route filtered by ai confidence %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          confidence,
          minConfidence: MIN_AI_CONFIDENCE,
        });
        return {
          routeId,
          exchangeInstanceId,
          exchangeName,
          status: 'filtered',
          reason: `AI confidence too low (${confidence.toFixed(2)} < ${MIN_AI_CONFIDENCE})`
        };
      }

      logger.info(routeLogMessage(routeName, 'Using AI result'), { routeName, exchangeInstanceId, aiResult });
      routeParsed = applyAIResultToParsedStrategy(routeParsed, aiResult);
      debugRouting('route parsed strategy updated by ai %o', {
        strategyId: strategy.id,
        routeId,
        aiResult,
        routeParsed: summarizeParsedStrategy(routeParsed),
      });
    }

    // Filter by Supported Symbols (after final symbol is known).
    let isFiltered = false;
    let filterReason = '';
    try {
      let supported = route.supportedSymbols ? JSON.parse(route.supportedSymbols) : null;
      // Handle potential double-encoding from legacy bug
      if (typeof supported === 'string') {
        supported = JSON.parse(supported);
      }

      if (Array.isArray(supported) && supported.length > 0) {
        const normalizedSupported = supported
          .map((s: any) => normalizeRouteSymbol(s))
          .filter((s: string) => !!s);
        if (!normalizedSupported.includes(routeParsed.symbol)) {
          isFiltered = true;
          filterReason = `Symbol ${routeParsed.symbol} not in supported list`;
        }
      }
    } catch (e) {
      logger.warn(routeLogMessage(routeName, 'Failed to parse supportedSymbols'), { routeName, exchangeInstanceId, error: e });
    }

    if (isFiltered) {
      logger.info(routeLogMessage(routeName, `Signal filtered: ${filterReason}`), { routeName, exchangeInstanceId, reason: filterReason });
      await auditService.log(strategy.id, 'STRATEGY_FILTERED', {
        routeId,
        exchangeInstanceId,
        reason: filterReason
      }, undefined, undefined, exchangeInstanceId, routeId);
      debugRouting('route filtered by supported symbols %o', {
        strategyId: strategy.id,
        routeId,
        exchangeInstanceId,
        symbol: routeParsed.symbol,
        reason: filterReason,
      });

      return {
        routeId,
        exchangeInstanceId,
        exchangeName,
        status: 'filtered',
        reason: filterReason
      };
    }

    if (config.enableTrading) {
      // Execute trade (No transaction passed, handles its own DB ops like PendingProtection)
      try {
        // Get Risk Config
        // DYNAMIC CONFIG: Merge hardcoded default with DB override
        let defaultConfig = parser.getRiskConfig();
        let riskConfig = await parserConfigService.getEffectiveConfig(parser.name, defaultConfig);

        // Route Override
        if (route.riskSettings) {
          try {
            const routeRisk = JSON.parse(route.riskSettings);
            // Migrate legacy positionSizingMode='ratio_based' to riskMode='ratio_based'
            if ((routeRisk as any).positionSizingMode === 'ratio_based') {
              (routeRisk as any).riskMode = 'ratio_based';
              if (!(routeRisk as any).riskValue || (routeRisk as any).riskValue === 10) {
                (routeRisk as any).riskValue = 1;
              }
              delete (routeRisk as any).positionSizingMode;
            }
            riskConfig = { ...riskConfig, ...routeRisk };
            debugOrder('route risk settings applied %o', {
              strategyId: strategy.id,
              routeId,
              routeRisk,
            });
          } catch (e) {
            // Ignore invalid json
            debugOrder('route risk settings ignored due to invalid json %o', {
              strategyId: strategy.id,
              routeId,
              error: (e as any)?.message,
            });
          }
        }

        // Symbol Specific Override
        if (route.symbolSpecificSettings) {
          try {
            const specificSettings = JSON.parse(route.symbolSpecificSettings);
            const symbolConfig = specificSettings[routeParsed.symbol];

            if (symbolConfig && symbolConfig.riskValue !== undefined && symbolConfig.riskValue !== '') {
              const val = Number(symbolConfig.riskValue);
              if (!isNaN(val)) {
                riskConfig = { ...riskConfig, riskValue: val };
                logger.info(routeLogMessage(routeName, `Applied symbol specific risk value for ${routeParsed.symbol}: ${val}`), { routeName, exchangeInstanceId, symbol: routeParsed.symbol, riskValue: val });
                debugOrder('symbol specific risk value applied %o', {
                  strategyId: strategy.id,
                  routeId,
                  symbol: routeParsed.symbol,
                  riskValue: val,
                });
              }
            }
          } catch (e) {
            logger.warn(routeLogMessage(routeName, 'Failed to apply symbolSpecificSettings'), { routeName, exchangeInstanceId, error: e });
            debugOrder('symbol specific settings failed %o', {
              strategyId: strategy.id,
              routeId,
              error: (e as any)?.message,
            });
          }
        }

        logger.info(routeLogMessage(routeName, `Executing trade with parser ${parser.name} on ${exchangeName}`), { routeName, exchangeInstanceId, exchangeName, parserName: parser.name, riskConfig });

        // ── 入场点选择（riskConfig.entrySelection）──
        // 'nearest_sl'：多入场点信号只在与止损最近的入场点全仓入场，其余入场点本路由跳过；
        // 默认 'all'（含未配置）保持现状：全部入场点按 weight 均分。
        const entrySelection = applyEntrySelection(routeParsed, riskConfig);
        if (entrySelection.filtered) {
          logger.info(routeLogMessage(routeName, `Signal filtered by entry selection: ${entrySelection.reason}`), { routeName, exchangeInstanceId, reason: entrySelection.reason });
          await auditService.log(strategy.id, 'STRATEGY_FILTERED', {
            routeId,
            exchangeInstanceId,
            reason: entrySelection.reason
          }, undefined, undefined, exchangeInstanceId, routeId);
          debugRouting('route filtered by entry selection %o', {
            strategyId: strategy.id,
            routeId,
            exchangeInstanceId,
            symbol: routeParsed.symbol,
            reason: entrySelection.reason,
          });
          return {
            routeId,
            exchangeInstanceId,
            exchangeName,
            status: 'filtered',
            reason: entrySelection.reason
          };
        }
        if (entrySelection.parsed !== routeParsed) {
          routeParsed = entrySelection.parsed;
          debugRouting('route parsed strategy updated by entry selection %o', {
            strategyId: strategy.id,
            routeId,
            exchangeInstanceId,
            routeParsed: summarizeParsedStrategy(routeParsed),
          });
        }

        debugOrder('trade execution requested %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          exchangeName,
          parserName: parser.name,
          parsed: summarizeParsedStrategy(routeParsed),
          riskConfig,
        });

        // --- 第二层：策略幂等检查 ---
        const dedupTargets: string = Array.isArray(routeParsed.targets)
          ? JSON.stringify([...(routeParsed.targets as any[])].sort())
          : (routeParsed.targets || '');

        // Strategy A fix: infer orderType from entryPrice — market orders have no entryPrice
        const inferredOrderType = routeParsed.entryPrice ? 'limit' : 'market';

        const dedupResult = await strategyDedupService.check({
          parserName,
          symbol: routeParsed.symbol,
          side: routeParsed.side || 'unknown',
          entryPrice: routeParsed.entryPrice || '',
          targets: dedupTargets,
          stopLoss: routeParsed.stopLoss || '',
          source,
          exchangeInstanceId,
          routeId,
          orderType: inferredOrderType,
        });
        debugOrder('strategy dedup checked %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          isDuplicate: dedupResult.isDuplicate,
          duplicateOrderId: dedupResult.duplicateOrderId,
        });

        if (dedupResult.isDuplicate) {
          strategy.status = 'filtered';
          try {
            await strategy.save();
          } catch (e: any) {
            logger.warn(routeLogMessage(routeName, 'Failed to save filtered strategy status'), formatError(e, { routeName, exchangeInstanceId, strategyId: strategy.id }));
          }
          await strategyDedupService.logDuplicate(
            strategy.id,
            {
              parserName,
              symbol: routeParsed.symbol,
              side: routeParsed.side || 'unknown',
              entryPrice: routeParsed.entryPrice || '',
              targets: dedupTargets,
              stopLoss: routeParsed.stopLoss || '',
              source,
              exchangeInstanceId,
              routeId,
              orderType: inferredOrderType,
            },
            dedupResult.duplicateOrderId!
          );
          return {
            routeId,
            exchangeInstanceId,
            exchangeName,
            status: 'filtered',
            reason: 'strategy_duplicate',
            duplicateOrderId: dedupResult.duplicateOrderId,
          };
        }

        // Execute single strategy
        const orderResult = await tradeExecutor.execute(routeParsed, riskConfig, source, strategy.id, exchangeInstanceId, routeId);
        debugOrder('trade executor returned %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          result: orderResult,
        });

        if (orderResult) {
          const resultId = orderResult.id ? String(orderResult.id) : undefined;
          let trackedOrder = resultId
            ? await Order.findOne({ where: { exchangeOrderId: resultId, exchangeInstanceId } })
            : null;

          // Some execute paths return local DB id (e.g. db-duplicate-active) instead of exchange order id.
          if (!trackedOrder && resultId && /^\d+$/.test(resultId)) {
            trackedOrder = await Order.findOne({
              where: { id: Number(resultId), exchangeInstanceId }
            });
          }

          // Sentinel ids (e.g. close-pos/update-sl) have no exchange order id; fall back to latest tracked order.
          if (!trackedOrder) {
            trackedOrder = await Order.findOne({
              where: {
                strategyId: strategy.id,
                symbol: routeParsed.symbol,
                exchangeInstanceId
              },
              order: [['createdAt', 'DESC']]
            });
          }
          const exchangeOrderId = trackedOrder?.exchangeOrderId || undefined;

          await auditService.log(
            strategy.id,
            'ROUTE_EXECUTED',
            {
              routeId,
              exchangeInstanceId,
              exchangeName,
              action: routeParsed.action,
              exchangeOrderId,
              resultId,
              status: orderResult.status,
              details: orderResult
            },
            trackedOrder?.id,
            trackedOrder?.lifecycleStatus,
            exchangeInstanceId,
            routeId
          );
          debugOrder('route executed %o', {
            strategyId: strategy.id,
            routeId,
            exchangeInstanceId,
            orderId: trackedOrder?.id,
            exchangeOrderId,
            resultId,
            status: orderResult.status,
          });

          return {
            routeId,
            exchangeInstanceId,
            exchangeName,
            status: 'executed',
            orderId: trackedOrder?.id,
            exchangeOrderId,
            details: orderResult
          };
        } else {
          debugOrder('route skipped because executor returned null %o', {
            strategyId: strategy.id,
            routeId,
            exchangeInstanceId,
          });
          return {
            routeId,
            exchangeInstanceId,
            exchangeName,
            status: 'skipped', // e.g. duplicate or other logic in execute
            reason: 'TradeExecutor returned null'
          };
        }

      } catch (tradeError: any) {
        logger.error('Trade execution failed', formatError(tradeError, { routeName, exchangeInstanceId, routeId, strategyId: strategy.id, symbol: routeParsed.symbol }));
        await auditService.log(strategy.id, 'ORDER_FAILED', { error: tradeError.message }, undefined, undefined, exchangeInstanceId, routeId);
        debugOrder('trade execution failed %o', {
          strategyId: strategy.id,
          routeId,
          exchangeInstanceId,
          error: tradeError.message,
        });

        return {
          routeId,
          exchangeInstanceId,
          exchangeName,
          status: 'failed',
          error: tradeError.message
        };
      }
    } else {
      logger.info(routeLogMessage(routeName, 'Trading disabled globally, skipping order placement'), {
        routeName,
        exchangeInstanceId,
        symbol: routeParsed.symbol,
        reason: 'global_config',
        tradingMode: config.trading.mode,
        enableTrading: config.enableTrading
      });
      debugOrder('route simulated because trading disabled %o', {
        strategyId: strategy.id,
        routeId,
        exchangeInstanceId,
        symbol: routeParsed.symbol,
        tradingMode: config.trading.mode,
        enableTrading: config.enableTrading,
      });

      await Order.create({
        strategyId: strategy.id,
        routeId: routeId,
        exchangeOrderId: `sim_${Date.now()}_${Math.random()}`,
        exchangeInstanceId: exchangeInstanceId,
        exchange: exchangeName,
        symbol: routeParsed.symbol,
        side: routeParsed.side || 'unknown',
        amount: '0',
        price: routeParsed.entryPrice,
        status: 'simulated',
        response: '{"simulated": true}',
        isSimulated: true,
        // 回测子进程：记录为对应信号时间；实盘 nowOrSim() === new Date()
        createdAt: nowOrSim(),
        updatedAt: nowOrSim(),
      });

      return {
        routeId,
        exchangeInstanceId,
        exchangeName,
        status: 'simulated'
      };
    }

  } catch (err: any) {
    logger.error(routeLogMessage(routeName, 'Strategy processing failed for route'), formatError(err, { routeName, exchangeInstanceId }));
    return {
      routeId,
      exchangeInstanceId,
      exchangeName,
      status: 'error',
      error: err.message
    };
  }
}
