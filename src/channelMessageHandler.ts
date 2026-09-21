import crypto from 'crypto';
import logger, { logContext, formatError } from './utils/logger';
import routingService from './services/RoutingService';
import statsService from './services/StatsService';
import strategyParserRegistry from './services/parsers';
import auditService from './services/AuditService';
import aiParserService from './services/AIParserService';
import { createNamedStageDebug, createStageDebug, summarizeDebugMessage } from './utils/debug';
import { summarizeParsedStrategy, summarizeRoute } from './messageHelpers';
import { processStrategiesForParser } from './strategyProcessor';

const debugMessage = createStageDebug('message');
const debugRouting = createStageDebug('routing');
const debugParser = createStageDebug('parser');

export async function handleChannelMessage(message: any): Promise<void> {
  const traceId = crypto.randomInt(10000000, 99999999).toString();
  await logContext.run(new Map([['context', { traceId }]]), async () => {
    // logger.info('Received message', { message });
    debugMessage('message received %o', {
      traceId,
      ...summarizeDebugMessage(message),
    });
    await statsService.incrementTotalMsg();

    const channelId = message.channel_id || 'unknown';
    const routes = routingService.getRoutes(channelId);

    if (!routes || routes.length === 0) {
      debugRouting('no routes matched message %o', {
        traceId,
        channelId,
        messageId: message.id,
      });
      return;
    }
    debugRouting('routes matched message %o', {
      traceId,
      channelId,
      messageId: message.id,
      routeCount: routes.length,
      routes: routes.map(summarizeRoute),
    });

    // Group routes by Parser to handle potentially different parsers for same channel.
    // Some parsers need route-scoped context, so those are intentionally split per route.
    const routesByParser = new Map<string, { parserName: string; routeList: any[] }>();
    for (const route of routes) {
      const pName = (route as any).parser || 'DefaultParser'; // Default fallback
      const parser = strategyParserRegistry.getParserByName(pName);
      const routeScoped = !!(parser as any)?.requiresRouteScopedParsing;
      const key = routeScoped ? `${pName}:route:${(route as any).id}` : pName;
      if (!routesByParser.has(key)) {
        routesByParser.set(key, { parserName: pName, routeList: [] });
      }
      routesByParser.get(key)!.routeList.push(route);
    }
    debugRouting('routes grouped by parser %o', {
      traceId,
      channelId,
      groups: Array.from(routesByParser.entries()).map(([key, value]) => ({
        key,
        parserName: value.parserName,
        routeIds: value.routeList.map((route) => route.id),
      })),
    });

    // Execute parsers in parallel
    await Promise.all(Array.from(routesByParser.values()).map(async ({ parserName, routeList }) => {
      const parser = strategyParserRegistry.getParserByName(parserName);
      if (!parser) {
        logger.warn(`Parser ${parserName} not found for channel ${channelId}`);
        debugParser('parser missing %o', {
          traceId,
          channelId,
          parserName,
          routeIds: routeList.map((route) => route.id),
        });
        return;
      }
      const parserDebug = createNamedStageDebug('parser', parserName);

      const parserRouteContext = {
        routeIds: routeList.map((r) => Number((r as any).id)).filter((id) => Number.isFinite(id)),
        routeNames: routeList.map((r) => String((r as any).name || `Route ${(r as any).id}`)).filter(Boolean),
      };
      let strategies;
      const parseStartedAt = Date.now();
      try {
        debugParser('parser started %o', {
          traceId,
          channelId,
          parserName,
          routeIds: parserRouteContext.routeIds,
        });
        parserDebug('started %o', {
          traceId,
          channelId,
          routeIds: parserRouteContext.routeIds,
          message: summarizeDebugMessage(message),
        });
        strategies = await aiParserService.runWithRouteContext(parserRouteContext, () => parser.parse(message));
        const durationMs = Date.now() - parseStartedAt;
        debugParser('parser completed %o', {
          traceId,
          channelId,
          parserName,
          routeIds: parserRouteContext.routeIds,
          durationMs,
          strategyCount: strategies?.length || 0,
        });
        parserDebug('completed %o', {
          traceId,
          durationMs,
          strategies: (strategies || []).map(summarizeParsedStrategy),
        });
      } catch (err: any) {
        logger.error('Parser failed', formatError(err, { parserName, channelId }));
        const durationMs = Date.now() - parseStartedAt;
        debugParser('parser failed %o', {
          traceId,
          channelId,
          parserName,
          routeIds: parserRouteContext.routeIds,
          durationMs,
          ...formatError(err),
        });
        parserDebug('failed %o', { traceId, durationMs, ...formatError(err) });
        // Audit Parser Failure
        await auditService.log(0, 'PARSER_ERROR', formatError(err, {
          parser: parserName,
          channelId: channelId,
          raw: message
        }));
        return;
      }

      await processStrategiesForParser({ traceId, channelId, message, parserName, routeList, parser, strategies });
    }));
  });
}
