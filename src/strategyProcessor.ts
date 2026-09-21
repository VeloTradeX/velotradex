import logger, { logContext, formatError } from './utils/logger';
import { Strategy } from './models';
import aiParserService, { AIAnalysisResult } from './services/AIParserService';
import auditService from './services/AuditService';
import idempotencyService from './services/IdempotencyService';
import marketService from './services/MarketService';
import statsService from './services/StatsService';
import { safeStringify } from './utils/json';
import { createStageDebug } from './utils/debug';
import { BUILT_IN_AI_PARSERS, extractDiscordMessageText, summarizeParsedStrategy } from './messageHelpers';
import { executeRouteForStrategy } from './routeExecution';
import { nowOrSim } from './backtest/Clock';

const debugStrategy = createStageDebug('strategy');

export interface ParserStrategiesContext {
  traceId: string;
  channelId: string;
  message: any;
  parserName: string;
  routeList: any[];
  parser: any;
  strategies: any;
}

export async function processStrategiesForParser(ctx: ParserStrategiesContext): Promise<void> {
  const { traceId, channelId, message, parserName, routeList, parser, strategies } = ctx;
  const messageContent = extractDiscordMessageText(message);
  if (strategies && strategies.length > 0) {
    debugStrategy('parser produced strategies %o', {
      traceId,
      channelId,
      parserName,
      strategyCount: strategies.length,
      routeIds: routeList.map((route) => route.id),
    });
    // --- 第一层：消息幂等检查 ---
    {
      if (messageContent.trim() !== '') {
        debugStrategy('checking message idempotency %o', {
          traceId,
          channelId,
          messageId: message.id,
          contentLength: messageContent.length,
        });
        const { isDuplicate } = await idempotencyService.checkMessage(
          channelId,
          messageContent
        );
        if (isDuplicate) {
          await idempotencyService.logDuplicate(channelId, messageContent, message.id);
          logger.info(`Skipping duplicate message ${message.id} from channel ${channelId}`);
          debugStrategy('message duplicate skipped %o', {
            traceId,
            channelId,
            messageId: message.id,
            parserName,
          });
          return;
        }
      }
    }

    await statsService.incrementMatchedMsg();

    for (const parsed of strategies) {
      await statsService.incrementParsedStrategy();

      const source = channelId;
      let strategy: Strategy;

      try {
        // AI Analysis Integration
        // Moved to per-route logic below
        // let aiResult: any = null;
        // const aiMode = aiParserService.getMode();

        strategy = await Strategy.create({
          rawMessage: JSON.stringify(message),
          action: parsed.action,
          symbol: parsed.symbol,
          side: parsed.side || 'unknown', // Default if missing
          entryPrice: parsed.entryPrice,
          targets: JSON.stringify(parsed.targets),
          stopLoss: parsed.stopLoss,
          status: 'pending',
          source: source,
          parserName: parserName,
          routes: '[]',
          aiAnalysis: null, // Will be updated by route processing if needed
          riskMultiplier: parsed.riskMultiplier ?? 1.0,
          signalOrigin: parsed.sourceType || null,
          // 回测子进程：记录为原始信号时间；实盘进程 nowOrSim() === new Date()
          createdAt: nowOrSim(),
          updatedAt: nowOrSim(),
        });
        debugStrategy('strategy record created %o', {
          traceId,
          strategyId: strategy.id,
          parserName,
          source,
          parsed: summarizeParsedStrategy(parsed),
          routeIds: routeList.map((route) => route.id),
        });

        // Update Trace ID for this strategy processing context
        const strategyTraceId = `celue-${strategy.id}`;
        await logContext.run(new Map([['context', { traceId: strategyTraceId, strategyId: strategy.id, parserName }]]), async () => {
          await auditService.log(strategy.id, 'STRATEGY_DETECTED', {
            parser: parserName,
            source: source,
            parsed: parsed
          });

          const parserHasBuiltInAI = BUILT_IN_AI_PARSERS.has(parserName);
          const hasSyncAI = !parserHasBuiltInAI && routeList.some((r) => ((r as any).aiMode || 'disabled') === 'enabled');
          const hasAsyncAI = !parserHasBuiltInAI && routeList.some((r) => ((r as any).aiMode || 'disabled') === 'analyze_only');
          const aiRouteList = routeList.filter((r) => ((r as any).aiMode || 'disabled') !== 'disabled');
          const aiRouteContext = {
            routeIds: aiRouteList.map((r) => Number((r as any).id)).filter((id) => Number.isFinite(id)),
            routeNames: aiRouteList.map((r) => String((r as any).name || `Route ${(r as any).id}`)).filter(Boolean),
          };
          let aiPromise: Promise<AIAnalysisResult | null> | null = null;
          let currentPricePromise: Promise<number> | null = null;
          debugStrategy('strategy route ai modes resolved %o', {
            strategyId: strategy.id,
            parserName,
            parserHasBuiltInAI,
            hasSyncAI,
            hasAsyncAI,
            aiRouteContext,
          });

          const getCurrentPrice = async () => {
            if (!currentPricePromise) {
              debugStrategy('fetching current price for ai %o', {
                strategyId: strategy.id,
                symbol: parsed.symbol,
              });
              currentPricePromise = marketService.getCurrentPrice(parsed.symbol);
            }
            return currentPricePromise;
          };

          const getAIResult = async (): Promise<AIAnalysisResult | null> => {
            if (!aiPromise) {
              const currentPrice = await getCurrentPrice();
              debugStrategy('starting ai analysis %o', {
                strategyId: strategy.id,
                symbol: parsed.symbol,
                currentPrice,
                aiRouteContext,
              });
              aiPromise = aiParserService.analyze(message, currentPrice, source, strategy.id, aiRouteContext);
            }
            return aiPromise;
          };

          if (hasAsyncAI && !hasSyncAI) {
            void getAIResult().catch((err: any) => {
              logger.error(`Strategy ${strategy.id}: async AI analysis failed`, formatError(err));
            });
          }

          let sharedAIResult: AIAnalysisResult | null = null;
          if (hasSyncAI) {
            sharedAIResult = await getAIResult();
            strategy.aiAnalysis = sharedAIResult ? JSON.stringify(sharedAIResult) : null;
            await strategy.save();
            debugStrategy('sync ai analysis completed %o', {
              strategyId: strategy.id,
              aiResult: sharedAIResult,
            });
          }

          // Execute routes in parallel
          const routeResults = await Promise.all(routeList.map((route) => executeRouteForStrategy({
            strategy,
            parsed,
            route,
            source,
            parserName,
            parser,
            parserHasBuiltInAI,
            sharedAIResult,
            getAIResult,
          })));

          // Update Strategy with consolidated results
          strategy.routes = safeStringify(routeResults);

          const hasExecuted = routeResults.some((r: any) => r.status === 'executed' || r.status === 'simulated');
          const hasFailed = routeResults.some((r: any) => r.status === 'failed' || r.status === 'error');
          debugStrategy('route processing completed %o', {
            strategyId: strategy.id,
            routeResults,
            hasExecuted,
            hasFailed,
          });

          if (hasExecuted) {
            strategy.status = 'processed';
          } else if (hasFailed && !hasExecuted) {
            strategy.status = 'failed';
          } else {
            strategy.status = 'filtered'; // or 'skipped'
          }

          // 写入消息幂等键（仅在有实际交易执行时）
          if (hasExecuted) {
            try {
              await idempotencyService.writeKey(
                channelId,
                messageContent,
                message.id ?? null,
                strategy.id
              );
              debugStrategy('message idempotency key written %o', {
                strategyId: strategy.id,
                channelId,
                messageId: message.id,
              });
            } catch (e: any) {
              logger.warn('Failed to write idempotency key', formatError(e, { strategyId: strategy.id }));
              debugStrategy('message idempotency key write failed %o', {
                strategyId: strategy.id,
                channelId,
                messageId: message.id,
                error: e.message,
              });
            }
          }

          try {
            await strategy.save();
          } catch (e: any) {
            logger.warn('Failed to save strategy with route results', formatError(e, { strategyId: strategy.id }));
          }

          logger.info('Strategy processing completed', { strategyId: strategy.id, status: strategy.status });
          debugStrategy('strategy processing completed %o', {
            strategyId: strategy.id,
            status: strategy.status,
            routes: routeResults,
          });
        }); // End of strategy traceId context

      } catch (err: any) {
        logger.error('Failed to save strategy', formatError(err, { parserName, channelId }));
        debugStrategy('strategy save or processing failed %o', {
          traceId,
          parserName,
          error: err.message,
          parsed: summarizeParsedStrategy(parsed),
        });
        await auditService.log(0, 'STRATEGY_SAVE_ERROR', { error: err.message, raw: message });
        return; // Skip if we can't save strategy
      }
    }
  }
}
