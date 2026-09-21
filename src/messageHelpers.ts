export const MIN_AI_CONFIDENCE = 0.5;
export const BUILT_IN_AI_PARSERS = new Set(['RaizexbtParser', 'AlwaysWinParser', 'WWGParser', 'GaulsParser', 'MansoorParser']);

export function summarizeParsedStrategy(parsed: any) {
  if (!parsed) return parsed;
  return {
    action: parsed.action,
    symbol: parsed.symbol,
    side: parsed.side,
    entryPrice: parsed.entryPrice,
    targets: Array.isArray(parsed.targets) ? parsed.targets : [],
    stopLoss: parsed.stopLoss,
    orderType: parsed.orderType,
    closePercentage: parsed.closePercentage,
    closePrice: parsed.closePrice,
    closeAmount: parsed.closeAmount,
    orderId: parsed.orderId,
    riskMultiplier: parsed.riskMultiplier,
  };
}

export function summarizeRoute(route: any) {
  return {
    id: route.id,
    name: route.name,
    parser: route.parser || 'DefaultParser',
    exchangeInstanceId: route.exchangeInstanceId,
    aiMode: route.aiMode || 'disabled',
  };
}

export function routeDisplayName(route: any): string {
  return String(route?.name || `Route ${route?.id ?? 'unknown'}`);
}

export function routeLogMessage(routeName: string, message: string): string {
  return `[route=${routeName}] ${message}`;
}

export function extractDiscordMessageText(message: any): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const firstEmbedDescription = Array.isArray(message.embeds)
      ? String(message.embeds[0]?.description || '').trim()
      : '';
    if (firstEmbedDescription) return firstEmbedDescription;
    if (message.content) return String(message.content);
  }
  return '';
}
