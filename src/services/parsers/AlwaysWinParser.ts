import { IStrategyParser, ParsedStrategy, StrategyRiskConfig, DiscordMessage } from './types';
import logger, { formatError } from '../../utils/logger';
import * as crypto from 'crypto';

export class AlwaysWinParser implements IStrategyParser {
  name = 'AlwaysWinParser';
  private lastParsedStrategies: Map<string, ParsedStrategy[]> = new Map();
  // Deduplication Cache: Content Hash -> Timestamp
  private processedMessageHashes: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 1000 * 60 * 10; // 10 Minutes window for duplicate content

  constructor() {
  }

  public getRiskConfig(): StrategyRiskConfig {
    return {
      riskMode: 'fixed',
      riskValue: 5, // $5 risk
      defaultLeverage: '10',
      priceTolerance: 0.01, // 价格容忍度 0.01R (Prevent chasing price too far)
      entryPaddingR: 0.01, // 0.01
      entryOrderMode: 'taker',
      tpPaddingR: 0.01, // 0.01
      slPaddingR: 0.01, // 0.01
      
      // Default TP behavior for AlwaysWin
      // Assuming user might want to configure this, but hardcoding defaults based on request context:
      // "1. 默认的平仓位置...在止盈策略之外...例如 1" -> Left undefined by default as requested.
      // "2. 每个目标位置平仓比例...[0.8, 0.2]" -> Can be set here.
      // For AlwaysWin, they usually have 3-4 targets. Let's set a default distribution or leave it empty?
      // User request: "每个 parser 的 getRiskConfig 中，需要配置".
      // I will add the fields but keep them undefined or set reasonable defaults if needed.
      // Let's set a default distribution that favors early profit taking as AlwaysWin TPs are often close.
      tpDistribution: [0.6, 0.3, 0.1], // Example: 50% TP1, 30% TP2, 20% TP3.
      tpOrderType: 'limit',
      tpOrderMode: 'maker',
      autoCloseOppositePosition: false // Default off
    };
  }

  public async parse(message: any, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
    const discordMsg = message as DiscordMessage;
    
    // 0. Deduplication Check (Content-based)
    // Only check if it's NOT an edit of a known message (edits have same ID)
    // But duplicate messages usually have DIFFERENT IDs but SAME content.
    // We check content hash.
    if (discordMsg.content) {
        const hash = crypto.createHash('md5').update(discordMsg.content.trim()).digest('hex');
        const now = Date.now();
        const lastSeen = this.processedMessageHashes.get(hash);

        // 1. Duplicate Content Check (Different ID, Same Content)
        if (lastSeen && (now - lastSeen < this.DEDUP_WINDOW_MS)) {
             // If we saw this exact content recently...
             
             // Case A: Same Message ID (Edit) -> ALLOW
             // Case B: Different Message ID (Duplicate/Forward) -> BLOCK
             
             if (!this.lastParsedStrategies.has(discordMsg.id)) {
                logger.info('AlwaysWinParser: Message cache hit (content hash)', { id: discordMsg.id, hash });
                 return null;
             }
        }
        
        // Update hash timestamp
        this.processedMessageHashes.set(hash, now);
        
        // Cleanup old hashes occasionally
        if (this.processedMessageHashes.size > 1000) {
            for (const [k, v] of this.processedMessageHashes.entries()) {
                if (now - v > this.DEDUP_WINDOW_MS) {
                    this.processedMessageHashes.delete(k);
                }
            }
        }
    }

    const newStrategies = await this.parseContent(discordMsg);

    // If Dry Run, skip state checks and updates
    if (isDryRun) {
        return newStrategies;
    }

    const oldStrategies = this.lastParsedStrategies.get(discordMsg.id);

    // Handle Edit / Duplicate
    if (oldStrategies) {
      if (this.areStrategiesEqual(oldStrategies, newStrategies)) {
        logger.info('AlwaysWinParser: Message cache hit (unchanged edit)', { id: discordMsg.id });
        // No semantic change
        return null;
      }

      logger.info('AlwaysWinParser: Message edited', { id: discordMsg.id });

      const attachments = (discordMsg as any).attachments;
      const hasAttachmentOnly = (!discordMsg.content || !discordMsg.content.trim()) && Array.isArray(attachments) && attachments.length > 0;
      if (hasAttachmentOnly) {
          logger.info('AlwaysWinParser: Ignoring attachment-only edit, keeping previous strategy active', { id: discordMsg.id });
          return null;
      }

      // Check if the new content is a "Keep Alive" status update (e.g. TP report, Entry Achieved)
      // If so, we should IGNORE it and NOT close the previous strategy.
      if (this.isKeepAliveMessage(discordMsg.content)) {
          logger.info('AlwaysWinParser: Ignoring status update, keeping previous strategy active', { id: discordMsg.id });
          return null;
      }

      if (newStrategies && newStrategies.length > 0) {
          this.lastParsedStrategies.set(discordMsg.id, newStrategies);
          return newStrategies;
      }
      return null;
    } else {
      // New Message
      if (newStrategies) {
        this.lastParsedStrategies.set(discordMsg.id, newStrategies);
        return newStrategies;
      }
    }

    return null;
  }

  private isKeepAliveMessage(content: string): boolean {
      if (!content) return false;
      
      const lowerContent = content.toLowerCase();
      const hasEntryTargets = /Entry Targets/i.test(content);
      const hasStopLoss = /Stop Targets|Stop Loss|\bSL\b/i.test(content);
      if (hasEntryTargets && !hasStopLoss) {
          return true;
      }

      // Profits / TP Reports
      const tpReportRegex = /Take-Profit target \d+|Profit:\s*[\d\.]+%?/i;
      if (tpReportRegex.test(content) || 
          content.includes('Take-Profit target') || 
          content.includes('Profit:') ||
          lowerContent.includes('profits') // Generic "profits" keyword
      ) {
          return true;
      }
      // Entry Achieved
      if (content.includes('All entry targets achieved') || content.includes('所有入场目标已达成')) {
          return true;
      }
      // Subscription/Ads (Ignore, don't close)
      if (content.includes('subscription') || content.includes('Portfolio management') || content.includes('discount')) {
          return true;
      }
      const announcementRegex = /(new update|update on|coming soon|即将推出|即將推出|新更新)/i;
      const tradeKeywordRegex = /(entry|entries|target|sl|stop loss|stop targets|leverage|long|short|signal type|tp\d)/i;
      if (announcementRegex.test(lowerContent) && !tradeKeywordRegex.test(lowerContent)) {
          return true;
      }
      return false;
  }

  private areStrategiesEqual(a: ParsedStrategy[] | null, b: ParsedStrategy[] | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;

    const clean = (s: ParsedStrategy) => {
      const { raw, ...rest } = s;
      return rest;
    };

    const aJson = JSON.stringify(a.map(clean));
    const bJson = JSON.stringify(b.map(clean));
    return aJson === bJson;
  }

  private async parseContent(message: DiscordMessage): Promise<ParsedStrategy[] | null> {
    try {
      const content = message.content;
      if (!content) return null;

      // 1. Filter irrelevant messages
      // STRICT: Ignore TP reports (User Request: 严格判断确定是止盈消息、保持忽略该类消息)
      // Example: #BTC/USDT Take-Profit target 1 ✅ 
      const tpReportRegex = /Take-Profit target \d+|Profit:\s*[\d\.]+%?/i;
      if (tpReportRegex.test(content) || content.includes('Take-Profit target') || content.includes('Profit:')) {
        logger.info('AlwaysWinParser: Ignoring TP report', { snippet: content.split('\n')[0] });
        return null;
      }
      // IGNORE "All entry targets achieved" (User Request)
      if (content.includes('All entry targets achieved') || content.includes('所有入场目标已达成')) {
        logger.info('AlwaysWinParser: Ignoring entry targets achieved report', { snippet: content.split('\n')[0] });
        return null;
      }
      if (content.includes('subscription') || content.includes('Portfolio management') || content.includes('discount')) {
        return null;
      }

      // 2. Check for Manual Cancel / Close
      // Format: "#ENA/USDT Manually Cancelled" or "#ETH/USDT Closed due to opposite direction signal"
      if (content.includes('Manually Cancelled') || content.includes('Closed due to opposite direction')) {
         const symbolMatch = content.match(/#?([A-Z0-9\/]+)\s+(?:Manually Cancelled|Closed)/i);
         if (symbolMatch) {
             let symbol = symbolMatch[1].replace('/', '_').toUpperCase();
             if (!symbol.includes('_')) symbol += '_USDT'; // Default

             if (await this.isValidSymbol(symbol)) {
                 return [{
                     action: 'close',
                     symbol,
                     closePercentage: 100,
                     raw: message
                 }];
             }
         }
         return null;
      }

      // 3. Normal Strategy Parsing
      // Normalize content
      const lines = content.split('\n').map((l: string) => l.trim()).filter((l: string) => l);

      let symbol = '';
      let side: 'buy' | 'sell' | undefined;
      let leverage = '';
      let entryPrice = '';
      let stopLoss = '';
      const targets: string[] = [];

      // Regex patterns
      const symbolSideRegex = /([A-Z0-9]+)\/USDT\s+(SHORT|LONG)/i;
      const coinCompactSymbolSideRegex = /Coin:\s*([A-Z0-9]+)USDT\s+(SHORT|LONG)/i;
      const newHeaderRegex = /(LONG|SHORT)\s+\$([A-Z0-9]+)(?:\s+(?:below|above|at)?\s*([\d\.]+))?/i;
      const symbolOnlyRegex = /#?([A-Z0-9]+)\/USDT/i;
      const signalTypeRegex = /Signal Type:.*?\((Short|Long)\)/i;

      const leverageRegex = /Leverage\s*-?\s*(\d+)x?/i;
      const labeledLeverageRegex = /Leverage:\s*(?:Isolated|Cross)?\s*x?(\d+)/i;
      const entryRegex = /(?:Entries|Entry|Entry Targets)[:\s]+(?:1\)\s*)?([\d\.]+)/i; 
      const targetRegex = /Target\s*\d+\s+([\d\.]+)/i;
      const labeledTargetRegex = /Target\s*\d+\s*:\s*([\d\.]+)/i;
      
      // Stop Loss Regexes
      // Priority 1: Explicit Stop Targets section
      // Matches "Stop Targets:" followed by newline/space and then "1) 67500"
      const stopTargetsSectionRegex = /Stop Targets:[\s\S]*?1\)\s*([\d\.]+)/i;
      
      // Priority 2: Standard SL line
      const slRegex = /(?:SL|Stop Loss|Stop)[:\s]+\s*(Breakeven|[\d\.]+)/i; 

      let isUpdate = false;
      if (content.includes('Trailing Configuration') || content.includes('✅')) {
          if (/Entry.*✅/i.test(content) || content.includes('Trailing Configuration')) {
              isUpdate = true;
          }
      }

      // Pre-extract Stop Targets to prioritize it over Trailing Config
      let explicitStopTarget: string | undefined;
      const stopTargetMatch = content.match(stopTargetsSectionRegex);
      if (stopTargetMatch) {
          explicitStopTarget = stopTargetMatch[1];
      }

      for (const line of lines) {
        // Symbol & Side (Standard)
        const symbolMatch = line.match(symbolSideRegex);
        if (symbolMatch) {
          symbol = `${symbolMatch[1]}_USDT`;
          const sideStr = symbolMatch[2].toLowerCase();
          if (sideStr === 'short') side = 'sell';
          else side = 'buy';
          continue;
        }

        // Coin label compact format: "Coin: LDOUSDT Short"
        const coinCompactSymbolSideMatch = line.match(coinCompactSymbolSideRegex);
        if (coinCompactSymbolSideMatch) {
          symbol = `${coinCompactSymbolSideMatch[1]}_USDT`;
          const sideStr = coinCompactSymbolSideMatch[2].toLowerCase();
          if (sideStr === 'short') side = 'sell';
          else side = 'buy';
          continue;
        }

        // Symbol Only (e.g. #BTC/USDT)
        const symbolOnlyMatch = line.match(symbolOnlyRegex);
        if (symbolOnlyMatch) {
             // Only set symbol if not set (or overwrite if cleaner?)
             // But we need side too. Side might be in another line.
             symbol = `${symbolOnlyMatch[1]}_USDT`;
             // Don't continue, might have other info? 
             // Actually continue is fine if one line has one info.
        }

        // Signal Type (Side)
        const signalTypeMatch = line.match(signalTypeRegex);
        if (signalTypeMatch) {
            const sideStr = signalTypeMatch[1].toLowerCase();
            if (sideStr === 'short') side = 'sell';
            else side = 'buy';
            continue;
        }

        // New Header Format: LONG $ETH below 1890
        const newHeaderMatch = line.match(newHeaderRegex);
        if (newHeaderMatch) {
            const sideStr = newHeaderMatch[1].toLowerCase();
            if (sideStr === 'short') side = 'sell';
            else side = 'buy';
            
            symbol = `${newHeaderMatch[2]}_USDT`;
            
            if (newHeaderMatch[3]) {
                entryPrice = newHeaderMatch[3];
            }
            continue;
        }

        // Leverage
        const leverageMatch = line.match(leverageRegex);
        if (leverageMatch) {
          leverage = leverageMatch[1];
          continue;
        }

        const labeledLeverageMatch = line.match(labeledLeverageRegex);
        if (labeledLeverageMatch) {
          leverage = labeledLeverageMatch[1];
          continue;
        }

        // Entry
        const entryMatch = line.match(entryRegex);
        if (entryMatch) {
          entryPrice = entryMatch[1];
          continue;
        }

        // SL
        // Priority: explicitStopTarget > line match
        if (explicitStopTarget) {
            stopLoss = explicitStopTarget;
        } else {
            const slMatch = line.match(slRegex);
            if (slMatch) {
              stopLoss = slMatch[1];
              if (stopLoss.toLowerCase() === 'breakeven') stopLoss = 'breakeven';
              continue;
            }
        }

        // Targets
        const targetMatch = line.match(targetRegex);
        if (targetMatch) {
          targets.push(targetMatch[1]);
          continue;
        }

        const labeledTargetMatch = line.match(labeledTargetRegex);
        if (labeledTargetMatch) {
          targets.push(labeledTargetMatch[1]);
          continue;
        }
      }

      // Validation
      if (!symbol || !side || (!entryPrice && !isUpdate)) {
          // Not a strategy message
          return null;
      }

      // STRICT SL Check (User Requirement 8)
      if (!stopLoss) {
          logger.warn('AlwaysWinParser: Ignoring strategy without SL', { symbol });
          return null;
      }

      // Sanity Check: SL vs Entry (User Requirement 4)
      if (entryPrice && stopLoss && stopLoss.toLowerCase() !== 'breakeven') {
          const ep = parseFloat(entryPrice);
          const sl = parseFloat(stopLoss);
          if (!isNaN(ep) && !isNaN(sl)) {
              if (side === 'buy' && sl >= ep) {
                  logger.warn('AlwaysWinParser: Invalid LONG SL (must be < entry)', { symbol, entry: ep, sl });
                  return null;
              }
              if (side === 'sell' && sl <= ep) {
                  logger.warn('AlwaysWinParser: Invalid SHORT SL (must be > entry)', { symbol, entry: ep, sl });
                  return null;
              }
          }
      }

      // Symbol Validation (User Requirement 5)
      if (!(await this.isValidSymbol(symbol))) {
          logger.warn('AlwaysWinParser: Invalid symbol', { symbol });
          return null;
      }

      return [{
        action: isUpdate ? 'update' : 'open',
        symbol,
        side,
        entryPrice,
        targets,
        stopLoss,
        leverage,
        raw: message,
      }];

    } catch (error: any) {
      logger.error('Error parsing strategy in AlwaysWinParser', formatError(error));
      return null;
    }
  }

  private async isValidSymbol(symbol: string): Promise<boolean> {
     // Symbol validation is now handled at the route level via supportedSymbols whitelist
     // and at execution level by the actual exchange instance.
     // Parser should not depend on a specific exchange's market list.
     
     // Basic format check: should contain underscore and common quote currencies
     if (!symbol.includes('_')) {
        return false;
     }
     
     const [base, quote] = symbol.split('_');
     if (!base || !quote) {
        return false;
     }
     
     // Allow common quote currencies
     const validQuotes = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
     if (!validQuotes.includes(quote)) {
        return false;
     }
     
     return true;
  }
}
