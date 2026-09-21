/**
 * ⚠️  稳定性说明：本解析器未经过长期实盘测试，解析结果与风控策略的可靠性不保证。
 * 如需在实盘环境使用，请先在 observe / testnet 模式下充分验证。
 */
import { IStrategyParser, ParsedStrategy, StrategyRiskConfig } from './types';
import { normalizeSymbol } from '../../utils/normalizeSymbol';
import aiParserService from '../AIParserService';
import marketService from '../MarketService';
import logger, { formatError } from '../../utils/logger';
import fs from 'fs';
import path from 'path';

class Mutex {
  private _locked = false;
  private _queue: (() => void)[] = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve(this._release.bind(this));
      } else {
        this._queue.push(() => {
          this._locked = true;
          resolve(this._release.bind(this));
        });
      }
    });
  }

  private _release() {
    if (this._queue.length > 0) {
      this._queue.shift()!();
    } else {
      this._locked = false;
    }
  }
}

type LLMAction = 'open' | 'close' | 'update' | 'cancel' | 'ignore';
type LLMSide = 'buy' | 'sell';

interface WWGLLMAction {
  action: LLMAction;
  symbol?: string;
  side?: LLMSide | 'long' | 'short';
  closePercentage?: number | string | null;
  closePrice?: number | string | null;
  entryPrice?: number | string | null;
  stopLoss?: number | string | null;
  targets?: Array<number | string>;
  orderType?: 'market' | 'limit';
  weight?: number;
  averageEntryPrice?: number;
  confidence?: number;
  reasoning?: string;
  // 多入场点组元数据（未成交挂单快照拆分时填写，透传给 ParsedStrategy）
  entryIndex?: number;
  entryCount?: number;
  groupEntries?: Array<{ type: 'market' | 'limit'; price?: number }>;
}

interface RouteSnapshot {
  description: string;
  messageId?: string;
  timestamp?: string;
}

interface WWGParserOptions {
  snapshotCacheFile?: string;
}

const SYSTEM_PROMPT = [
  'You are WWGParser, an expert crypto futures trading signal change parser.',
  'WWG messages are Discord embed snapshots, not ordinary chat messages.',
  'The actionable text is in embeds[].description. The description is a full state snapshot with Chinese section headers.',
  'You MUST compare the previous snapshot and the current snapshot and output only the order operations caused by the changes.',
  'A single snapshot diff may contain multiple changes; return all actionable changes in actions[].',
  'Do not repeat unchanged trades. Do not infer actions from PnL-only changes.',
  'Output ONLY valid JSON. No markdown, no code block, no explanation.'
].join(' ');

const DIFF_RULES = `<wwg_rules>
Input structure:
- "__**现有持仓（可入场）**__" means active positions that can be copied/entered.
- "__**未成交挂单**__" means pending entry orders.
- "__**失效单**__" means invalidated, closed, or no-longer-actionable trades.
- Rows under "__**失效单**__" must NEVER create action:open. They may only explain close/cancel/update outcomes for already tracked trades.
- Trade rows use Chinese direction: "做多" = buy/long, "做空" = sell/short.
- Symbol appears between **, e.g. **BTC**.
- Entry appears after "入场点:" and may be a single price or a range like "65200 − 64480".
- Stop loss appears after "止损:"; "盈亏平衡" means breakeven.
- Take profit appears after "止盈:"; "▶" means target pending/active, "✓" means target already hit.
- PnL changes alone are status updates and must be ignored.

Diff semantics:
1. New row in "未成交挂单" compared with previous snapshot => action:open, orderType:limit.
2. New row in "现有持仓（可入场）" compared with previous snapshot => action:open. Use orderType:market if it appears active without previously being a pending order; use orderType:limit if it moved from pending to active and the entry range remains actionable.
3. Row moved from "未成交挂单" to "现有持仓（可入场）" => action:open, unless the same symbol+side was already active before.
4. Active row disappears into "失效单" or disappears entirely => action:close with closePercentage:100.
5. Pending row disappears into "失效单" or disappears entirely without becoming active => action:cancel.
6. Stop loss change on an active trade => action:update with stopLoss. If new stop loss is "盈亏平衡", use stopLoss:"breakeven".
7. Stop loss change on a pending trade => action:update with stopLoss if the system can update the order; otherwise action:cancel followed by action:open. Prefer a single update when symbol and side are unchanged.
8. New active take-profit level marked "▶" => action:close with closePrice set to that TP price; omit closePercentage unless explicit.
9. Newly checked take-profit "✓" means that TP was hit. Output action:close with closePrice set to the TP price. If no percentage is stated, omit closePercentage so execution can use tpDistribution.
10. If a row only changes PnL, average value, timestamp, ordering, or formatting, action:ignore for that row.
11. A row that appears only in "失效单" in the current snapshot is not a new entry signal. Do not output action:open for it.
12. If both BTC long and BTC short pending rows exist, treat them as distinct by symbol+side+entry+stop.
13. If multiple trades changed, return multiple actions in chronological/section order.

Field rules:
- Normalize symbols as BASE_USDT, e.g. BTC_USDT, ETH_USDT, HYPE_USDT.
- For multiple entry prices or entry ranges, output one action:open per entry price. Do not collapse multiple entries into a midpoint.
- For split entries, include weight as 1 divided by entry count and averageEntryPrice as the arithmetic average for downstream sizing.
- For action:open, include side, orderType, entryPrice, stopLoss, targets if present, weight, averageEntryPrice, confidence.
- For action:update, include symbol and changed stopLoss and/or targets.
- For action:close, include symbol and closePercentage or closePrice when known.
- For action:cancel, include symbol and side when known.
- If required fields are ambiguous, omit that action rather than guessing.
</wwg_rules>`;

const OUTPUT_FORMAT = `<output_format>
{
  "actions": [
    {
      "action": "open|close|update|cancel|ignore",
      "symbol": "BTC_USDT",
      "side": "buy|sell",
      "closePercentage": number_or_null,
      "closePrice": number_or_null,
      "entryPrice": number_or_null,
      "stopLoss": number_or_"breakeven"_or_null,
      "targets": [number] or [],
      "orderType": "market|limit",
      "weight": number_or_null,
      "averageEntryPrice": number_or_null,
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation of the snapshot diff"
    }
  ]
}
</output_format>`;

export class WWGParser implements IStrategyParser {
  name = 'WWGParser';
  public readonly requiresRouteScopedParsing = true;
  private snapshotsByRouteKey: Map<string, RouteSnapshot> = new Map();
  private readonly snapshotCacheFile: string;
  private readonly snapshotMutex = new Mutex();
  private readonly snapshotLoadPromise: Promise<void>;

  constructor(options: WWGParserOptions = {}) {
    this.snapshotCacheFile = options.snapshotCacheFile || path.join(process.cwd(), 'data', 'wwg_snapshots.json');
    this.snapshotLoadPromise = this.loadSnapshotsFromDisk().catch(err => {
      logger.warn('WWGParser: initial snapshot load failed', formatError(err));
    });
  }

  public getRiskConfig(): StrategyRiskConfig {
    return {
      riskMode: 'fixed',
      riskValue: 10,
      defaultLeverage: '20',
      priceTolerance: 0.01, // 0.01R
      entryOrderMode: 'taker',
      tpDistribution: [0.5, 0.3, 0.2],
      tpOrderType: 'limit',
      tpOrderMode: 'maker',
      autoCloseOppositePosition: true,
      positionSizingMode: 'risk_based',
    };
  }

  public async parse(message: any, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
    await this.snapshotLoadPromise;
    const description = this.extractDescription(message);
    if (!description) return null;

    const routeContext = aiParserService.getCurrentRouteContext?.() || {};
    const routeId = routeContext.routeIds?.[0];
    const routeName = routeContext.routeNames?.[0];
    const routeKey = this.resolveRouteKey(message, routeId);
    const previous = this.snapshotsByRouteKey.get(routeKey);
    const current: RouteSnapshot = {
      description,
      messageId: message?.id,
      timestamp: message?.timestamp || message?.ts,
    };

    if (!previous) {
      const initialActions = this.parseInitialPendingOrders(current.description);
      if (!isDryRun) {
        await this.saveRouteSnapshot(routeKey, current);
      }
      logger.info('WWGParser: stored initial route snapshot', {
        routeKey,
        routeId,
        messageId: message?.id,
        initialPendingOrders: initialActions.length,
      });
      const strategies = this.convertToStrategies(initialActions, message, { description: '' }, current, routeId, routeName);
      return strategies.length > 0 ? strategies : null;
    }

    if (previous.description.trim() === description.trim()) {
      if (!isDryRun) {
        await this.saveRouteSnapshot(routeKey, current);
      }
      return null;
    }

    if (!aiParserService.isConfigured()) {
      logger.warn('WWGParser: AIParserService not configured, skipping');
      if (!isDryRun) {
        await this.saveRouteSnapshot(routeKey, current);
      }
      return null;
    }

    const actions = await this.analyzeDiff(previous, current, routeId, routeName);
    if (!isDryRun) {
      await this.saveRouteSnapshot(routeKey, current);
    }

    const strategies = this.convertToStrategies(actions, message, previous, current, routeId, routeName);
    return strategies.length > 0 ? strategies : null;
  }

  private async loadSnapshotsFromDisk(): Promise<void> {
    const release = await this.snapshotMutex.acquire();
    try {
      if (!fs.existsSync(this.snapshotCacheFile)) return;
      const raw = fs.readFileSync(this.snapshotCacheFile, 'utf-8');
      const parsed = JSON.parse(raw);
      const snapshots = parsed?.snapshots && typeof parsed.snapshots === 'object'
        ? parsed.snapshots
        : parsed;

      for (const [routeKey, snapshot] of Object.entries(snapshots || {})) {
        if (!snapshot || typeof snapshot !== 'object') continue;
        const value = snapshot as Partial<RouteSnapshot>;
        if (typeof value.description !== 'string' || !value.description.trim()) continue;
        this.snapshotsByRouteKey.set(routeKey, {
          description: value.description,
          messageId: value.messageId,
          timestamp: value.timestamp,
        });
      }
    } catch (error: any) {
      logger.warn('WWGParser: failed to load snapshot cache', formatError(error, { file: this.snapshotCacheFile }));
    } finally {
      release();
    }
  }

  private async saveRouteSnapshot(routeKey: string, snapshot: RouteSnapshot): Promise<void> {
    this.snapshotsByRouteKey.set(routeKey, snapshot);
    await this.persistSnapshotsToDisk();
  }

  private async persistSnapshotsToDisk(): Promise<void> {
    const release = await this.snapshotMutex.acquire();
    try {
      fs.mkdirSync(path.dirname(this.snapshotCacheFile), { recursive: true });
      const snapshots = Object.fromEntries(this.snapshotsByRouteKey.entries());
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        snapshots,
      };
      const tempFile = `${this.snapshotCacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tempFile, this.snapshotCacheFile);
    } catch (error: any) {
      logger.warn('WWGParser: failed to persist snapshot cache', formatError(error, { file: this.snapshotCacheFile }));
    } finally {
      release();
    }
  }

  private async analyzeDiff(
    previous: RouteSnapshot,
    current: RouteSnapshot,
    routeId?: number,
    routeName?: string
  ): Promise<WWGLLMAction[]> {
    const positionsXml = await aiParserService.buildPositions(this.name);
    const marketPricesXml = await marketService.getCommonMarketPricesXml();
    const userContent = [
      positionsXml,
      marketPricesXml,
      `<route id="${this.escapeXML(routeId ?? 'unknown')}" name="${this.escapeXML(routeName || '')}" />`,
      `<previous_snapshot message_id="${this.escapeXML(previous.messageId || '')}" ts="${this.escapeXML(previous.timestamp || '')}">`,
      this.escapeXML(previous.description),
      '</previous_snapshot>',
      `<current_snapshot message_id="${this.escapeXML(current.messageId || '')}" ts="${this.escapeXML(current.timestamp || '')}">`,
      this.escapeXML(current.description),
      '</current_snapshot>',
      DIFF_RULES,
      OUTPUT_FORMAT,
    ].join('\n\n');

    const response = await aiParserService.analyzeRaw({
      systemPrompt: SYSTEM_PROMPT,
      userContent,
      originalMessage: this.buildOriginalMessageLog(current),
      responseFormat: { type: 'json_object' },
      timeout: 60000,
    });

    if (!response?.content) return [];
    return this.parseResponseContent(response.content);
  }

  private parseResponseContent(content: string): WWGLLMAction[] {
    try {
      let json = content.trim();
      if (json.startsWith('```')) {
        json = json.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
      }
      const parsed = JSON.parse(json);
      const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [parsed];
      return rawActions
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => this.normalizeAction(item))
        .filter((item: WWGLLMAction | null): item is WWGLLMAction => !!item);
    } catch (error: any) {
      logger.error('WWGParser: failed to parse AI JSON response', formatError(error, { content }));
      return [];
    }
  }

  private buildOriginalMessageLog(snapshot: RouteSnapshot): any {
    return {
      id: snapshot.messageId,
      content: snapshot.description,
      timestamp: snapshot.timestamp,
    };
  }

  private parseInitialPendingOrders(description: string): WWGLLMAction[] {
    const pendingSection = this.extractSection(description, '未成交挂单');
    if (!pendingSection) return [];

    return pendingSection
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-') && !/No trades available/i.test(line))
      .flatMap((line) => this.parsePendingOrderLine(line))
      .filter((action: WWGLLMAction | null): action is WWGLLMAction => !!action);
  }

  private parsePendingOrderLine(line: string): WWGLLMAction[] {
    const directionMatch = line.match(/做\s*(多|空)/);
    if (!directionMatch) return [];

    const side: LLMSide = directionMatch[1] === '多' ? 'buy' : 'sell';
    const afterDirection = line.slice(directionMatch.index! + directionMatch[0].length);
    const symbolMatch = afterDirection.match(/(?:\*\*)?\s*([A-Z0-9]{2,20})(?:\*\*)?/i);
    if (!symbolMatch) return [];

    const entryText = this.extractFieldText(line, '入场点');
    const stopLossText = this.extractFieldText(line, '止损');
    const entryPrices = this.extractEntryPrices(entryText);
    const stopLoss = this.parsePriceFromText(stopLossText);
    if (entryPrices.length === 0 || typeof stopLoss !== 'number') return [];

    const targetsText = this.extractFieldText(line, '止盈');
    const targets = this.extractNumbers(targetsText);
    const averageEntryPrice = this.extractAverageEntryPrice(entryText) ||
      entryPrices.reduce((sum, price) => sum + price, 0) / entryPrices.length;
    const weight = 1 / entryPrices.length;
    // 组元数据：供路由级 entrySelection='nearest_sl' 判断哪个入场点距止损最近
    const groupEntries = entryPrices.map((price) => ({ type: 'limit' as const, price }));

    return entryPrices.map((entryPrice, index) => ({
      action: 'open',
      symbol: normalizeSymbol(symbolMatch[1]),
      side,
      orderType: 'limit',
      entryPrice,
      stopLoss,
      targets,
      weight,
      averageEntryPrice,
      confidence: 1,
      reasoning: 'Initial WWG snapshot pending order',
      entryIndex: index,
      entryCount: entryPrices.length,
      groupEntries,
    }));
  }

  private extractSection(description: string, sectionName: string): string {
    const lines = description.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => line.includes(sectionName));
    if (startIndex < 0) return '';

    const sectionLines: string[] = [];
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      if (/^__\*\*.*\*\*__$/.test(lines[i].trim())) break;
      sectionLines.push(lines[i]);
    }
    return sectionLines.join('\n').trim();
  }

  private extractFieldText(line: string, fieldName: string): string {
    const pattern = new RegExp(`${fieldName}:\\*{0,2}\\s*([^|\\n]+)`);
    const match = line.match(pattern);
    return match ? match[1].trim() : '';
  }

  private parsePriceFromText(text: string): number | undefined {
    const averageMatch = text.match(/平均值[:：]?\s*([0-9][0-9,]*(?:\.\d+)?)/);
    if (averageMatch) return this.parseNumericValue(averageMatch[1]);

    const numbers = this.extractNumbers(text);
    if (numbers.length === 0) return undefined;
    if (numbers.length === 1) return numbers[0];
    return (numbers[0] + numbers[1]) / 2;
  }

  private extractEntryPrices(text: string): number[] {
    const withoutAverage = String(text || '').replace(/平均值[:：]?\s*[0-9][0-9,]*(?:\.\d+)?/g, '');
    return this.extractNumbers(withoutAverage);
  }

  private extractAverageEntryPrice(text: string): number | undefined {
    const averageMatch = String(text || '').match(/平均值[:：]?\s*([0-9][0-9,]*(?:\.\d+)?)/);
    return averageMatch ? this.parseNumericValue(averageMatch[1]) : undefined;
  }

  private extractNumbers(text: string): number[] {
    return Array.from(String(text || '').matchAll(/[0-9][0-9,]*(?:\.\d+)?/g))
      .map((match) => this.parseNumericValue(match[0]))
      .filter((value): value is number => typeof value === 'number');
  }

  private normalizeAction(action: any): WWGLLMAction | null {
    const validActions: LLMAction[] = ['open', 'close', 'update', 'cancel', 'ignore'];
    if (!validActions.includes(action.action)) return null;
    if (action.action === 'ignore') return { action: 'ignore', reasoning: action.reasoning };

    const normalized: WWGLLMAction = {
      ...action,
      action: action.action,
    };

    if (normalized.symbol) normalized.symbol = normalizeSymbol(normalized.symbol);
    if (normalized.side) {
      const side = String(normalized.side).toLowerCase();
      if (side === 'long') normalized.side = 'buy';
      if (side === 'short') normalized.side = 'sell';
    }
    if (Array.isArray(normalized.targets)) {
      normalized.targets = normalized.targets
        .map((target) => this.parseNumericValue(target))
        .filter((target): target is number => typeof target === 'number');
    }
    return normalized;
  }

  private convertToStrategies(
    actions: WWGLLMAction[],
    rawMessage: any,
    previous: RouteSnapshot,
    current: RouteSnapshot,
    routeId?: number,
    routeName?: string
  ): ParsedStrategy[] {
    return actions.flatMap((action) => {
      if (action.action === 'ignore') return [];
      if (!action.symbol) return [];
      const symbol = action.symbol;
      action = {
        ...action,
        side: this.inferSideFromSnapshots(action, previous.description, current.description) || action.side,
      };
      const confidence = typeof action.confidence === 'number' ? action.confidence : 0.8;
      if (confidence < 0.3) return [];

      const raw = {
        ...rawMessage,
        wwg: {
          routeId,
          routeName,
          previousDescription: previous.description,
          currentDescription: current.description,
          reasoning: action.reasoning,
        },
      };

      if (action.action === 'open') {
        if (action.side !== 'buy' && action.side !== 'sell') return [];
        if (!this.isOpenActionInActionableCurrentSection(action, current.description)) {
          logger.warn('WWGParser: dropped open action not present in actionable current sections', {
            symbol,
            side: action.side,
            entryPrice: action.entryPrice,
            reason: action.reasoning,
          });
          return [];
        }
        const strategy: ParsedStrategy = {
          action: 'open',
          symbol,
          side: action.side,
          orderType: action.orderType || 'limit',
          raw,
        };
        if (typeof action.weight === 'number' && action.weight > 0 && action.weight <= 1) {
          strategy.weight = action.weight;
        }
        if (typeof action.averageEntryPrice === 'number' && Number.isFinite(action.averageEntryPrice)) {
          strategy.averageEntryPrice = action.averageEntryPrice;
        }
        // 多入场点组元数据透传（供路由级 entrySelection='nearest_sl' 使用）
        if (typeof action.entryIndex === 'number') strategy.entryIndex = action.entryIndex;
        if (typeof action.entryCount === 'number') strategy.entryCount = action.entryCount;
        if (Array.isArray(action.groupEntries)) strategy.groupEntries = action.groupEntries;
        this.assignPriceFields(strategy, action);
        return [strategy];
      }

      if (action.action === 'update') {
        const strategy: ParsedStrategy = {
          action: 'update',
          symbol,
          raw,
        };
        this.assignPriceFields(strategy, action);
        return [strategy];
      }

      if (action.action === 'close') {
        const strategy: ParsedStrategy = {
          action: 'close',
          symbol,
          raw,
        };
        const closePercentage = this.parsePercentage(action.closePercentage);
        const closePrice = this.parseNumericValue(action.closePrice);
        if (typeof closePercentage === 'number') strategy.closePercentage = closePercentage;
        if (typeof closePrice === 'number') strategy.closePrice = String(closePrice);
        return [strategy];
      }

      const strategy: ParsedStrategy = {
        action: 'cancel',
        symbol,
        side: action.side === 'buy' || action.side === 'sell' ? action.side : undefined,
        raw,
      };
      return [strategy];
    });
  }

  private isOpenActionInActionableCurrentSection(action: WWGLLMAction, currentDescription: string): boolean {
    if (!action.symbol) return false;
    const sections = [
      this.extractSection(currentDescription, '现有持仓'),
      this.extractSection(currentDescription, '未成交挂单'),
    ];

    const entryPrice = this.parseNumericValue(action.entryPrice);
    for (const section of sections) {
      const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (/No trades available/i.test(line)) continue;
        if (!this.lineContainsSymbol(line, this.symbolBase(action.symbol))) continue;
        if (typeof entryPrice !== 'number') return true;
        if (this.lineMatchesEntryPrice(line, entryPrice)) {
          return true;
        }
      }
    }

    return false;
  }

  private lineMatchesEntryPrice(line: string, entryPrice: number): boolean {
    const entryText = this.extractFieldText(line, '入场点');
    const prices = this.extractEntryPrices(entryText);
    if (prices.some((price) => Math.abs(price - entryPrice) < 1e-8)) return true;
    if (prices.length >= 2) {
      const low = Math.min(prices[0], prices[1]);
      const high = Math.max(prices[0], prices[1]);
      return entryPrice >= low && entryPrice <= high;
    }
    return false;
  }

  private assignPriceFields(strategy: ParsedStrategy, action: WWGLLMAction): void {
    const entryPrice = this.parseNumericValue(action.entryPrice);
    const stopLoss = this.normalizeStopLoss(action.stopLoss);
    if (typeof entryPrice === 'number') strategy.entryPrice = String(entryPrice);
    if (stopLoss != null) strategy.stopLoss = String(stopLoss);
    if (Array.isArray(action.targets) && action.targets.length > 0) {
      strategy.targets = action.targets.map((target) => String(target));
    }
  }

  private extractDescription(message: any): string {
    const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
    const description = embeds.length > 0
      ? String(embeds[0]?.description || '').trim()
      : String(message?.description || '').trim();
    return this.stripMarkdownLinks(description);
  }

  private stripMarkdownLinks(text: string): string {
    if (!text) return '';
    return text.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|discord:\/\/)[^)]+\)/g, '$1');
  }

  private inferSideFromSnapshots(
    action: WWGLLMAction,
    previousDescription: string,
    currentDescription: string
  ): 'buy' | 'sell' | undefined {
    if (!action.symbol) return undefined;

    const preferredDescriptions =
      action.action === 'open' || action.action === 'update'
        ? [currentDescription, previousDescription]
        : [previousDescription, currentDescription];

    for (const description of preferredDescriptions) {
      const side = this.findSideInDescription(action.symbol, description);
      if (side) return side;
    }

    return undefined;
  }

  private findSideInDescription(symbol: string, description: string): 'buy' | 'sell' | undefined {
    const base = this.symbolBase(symbol);
    if (!base) return undefined;

    const lines = description.split(/\r?\n/);
    for (const line of lines) {
      if (!this.lineContainsSymbol(line, base)) continue;
      if (line.includes('做多')) return 'buy';
      if (line.includes('做空')) return 'sell';
    }
    return undefined;
  }

  private lineContainsSymbol(line: string, base: string): boolean {
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const symbolPattern = new RegExp(`(?:\\*\\*|\\[|\\b)${escapedBase}(?:\\*\\*|\\]|\\b)`, 'i');
    return symbolPattern.test(line);
  }

  private resolveRouteKey(message: any, routeId?: number): string {
    if (Number.isFinite(routeId)) return `route:${routeId}`;
    return `channel:${message?.channel_id || 'unknown'}`;
  }

  // normalizeSymbol imported from ../../utils/normalizeSymbol

  private symbolBase(symbol: string): string {
    return normalizeSymbol(symbol).replace(/_USDT$/, '');
  }

  private parseNumericValue(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/[$,]/g, '').replace(/\s+/g, '').trim();
    if (!cleaned || cleaned.toLowerCase() === 'null') return undefined;
    const numeric = Number.parseFloat(cleaned);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  private normalizeStopLoss(value: unknown): string | number | undefined {
    if (typeof value === 'string' && /^(breakeven|break-even|be|盈亏平衡)$/i.test(value.trim())) {
      return 'breakeven';
    }
    return this.parseNumericValue(value);
  }

  private parsePercentage(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
    if (typeof value !== 'string') return undefined;
    const numeric = Number.parseFloat(value.replace('%', '').trim());
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : undefined;
  }

  private escapeXML(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
