import { Order, CfdLegGroup, CfdLeg } from '../../models';
import { Op } from 'sequelize';
import config from '../../config';
import logger, { formatError } from '../../utils/logger';
import { createNamedStageDebug } from '../../utils/debug';
import { OrderResult, Position } from '../exchanges/IExchange';
import { ParsedStrategy, StrategyRiskConfig } from '../parsers/types';
import { OrderPreCheck } from '../OrderPreCheck';
import { PositionSizer } from '../PositionSizer';
import { TpSlCalculator } from '../TpSlCalculator';
import { CfdLegPlanner } from '../exchanges/gate_cfd/CfdLegPlanner';
import { parsePositiveAmount, parseFinitePositiveNumber, isCmpEntryPrice, isFilledOrderStatus, formatExecutionNumber, roundToPrecision } from '../TradeMath';
import { buildCmpResolvedOpenStrategy, rejectOpenStrategy, validateOpenSignal, validateStaticOpenSignal, normalizeDisplayPriceScale } from '../OpenSignalValidator';
import { applyOpenPriceAdjustments } from '../OpenPriceAdjustment';
import { ExecutorServices, ExecutorCapabilities, summarizeParsedForDebug } from './deps';
import { ClosePositionService } from './ClosePositionService';
import cfdPriceSyncService from '../CfdPriceSyncService';
import { nowOrSim } from '../../backtest/Clock';

const debugOrderOpen = createNamedStageDebug('order', 'open');

export class OpenPositionService {
  constructor(
    private readonly services: ExecutorServices,
    private readonly capabilities: ExecutorCapabilities,
    private readonly closePositionService: ClosePositionService,
  ) {}

  private isLighterExchange(exchange: any): boolean {
      return exchange?.constructor?.name === 'LighterExchange';
  }

  /**
   * Gate-CFD 能力判断（独立适配器，productLine 标记）。
   * 兼容三类既有/新增命名：productLine='gate_cfd'、构造器名 GateCFDExchange、
   * 以及既有约定类型名 gate_tradfi（exchange.name 或构造器名 TradFiExchange）。
   */
  private isGateCfdExchange(exchange: any): boolean {
      return exchange?.productLine === 'gate_cfd'
          || exchange?.constructor?.name === 'GateCFDExchange'
          || exchange?.constructor?.name === 'TradFiExchange'
          || exchange?.name === 'gate_tradfi';
  }

  /**
   * CFD 开仓（多 TP = 多仓分腿，设计文档 §4.1）：
   * 1. CfdLegPlanner 规划腿（复用现有 riskMode/riskValue/maxPositionSize，不新增参数；
   *    逐腿放大到 minOrderVolume、封顶 maxOrderVolume、超限自动减腿重试、仍超限放弃）
   * 2. 建 cfd_leg_group 分组 + 每腿一行 Order + cfd_leg 明细（Order 表零改动，独立表关联）
   * 3. 单次 placeOrder 提交全部腿（适配器内部保证原子性：任一腿失败 → 全回滚）
   * 4. 成交确认走轮询（CFD 无 WebSocket），确认后直接 PROTECTED（保护下单自带）
   */
  private async handleCfdOpen(params: {
      exchange: any;
      parsed: ParsedStrategy;
      riskConfig: StrategyRiskConfig;
      source: string;
      strategyId?: number;
      exchangeInstanceId?: string;
      routeId?: number;
      marketInfo: any;
      ticker: any;
      currentPrice: number;
      cmpEntry: boolean;
      orderType: 'limit' | 'market';
      formattedEntryPrice?: string;
      resolvedEntryPrice: string;
      formattedStopLoss?: string;
      hasValidStopLoss: boolean;
      entryPrice: number;
      stopLoss: number;
      amount: string;
      contracts: number;
      sizingResult: any;
      tpResult: any;
      targetLeverage: string;
  }): Promise<OrderResult | null> {
      const { exchange, parsed, riskConfig, source, strategyId, exchangeInstanceId, routeId,
              marketInfo, orderType, formattedEntryPrice, resolvedEntryPrice, formattedStopLoss,
              entryPrice, stopLoss, amount, contracts, sizingResult, tpResult, targetLeverage } = params;

      // ── CFD 风控换算（勿删，维护必读）───────────────────────────────
      // 单笔风险上限 riskAmount：来自 route 风控设置「风险模式/风险值」（现有参数，未新增）
      //   fixed      → riskAmount = riskValue（USD，每笔最大亏损金额）
      //   percentage → riskAmount = equity × riskValue%（每笔最大权益亏损百分比）
      // 总风险 = Σ(腿手数 × contractVolume × |入场价 − 止损价|)，必须 ≤ riskAmount
      // 名义红线 = Σ(腿手数 × contractVolume × 入场价)，必须 ≤ maxPositionSize（现有参数「最大持仓(U)」）
      // 交易所硬限：minOrderVolume ≤ 每腿手数 ≤ maxOrderVolume（GET /tradfi/symbols/detail）
      // ─────────────────────────────────────────────────────────────────
      const minOrderVolume = parseFloat(marketInfo.minSize || '0') || 0;
      const maxOrderVolume = parseFloat(marketInfo.maxSize || '0') || 0;
      const contractVolume = parseFloat(marketInfo.multiplier || '1') || 1;

      const legPlan = new CfdLegPlanner().plan({
          entryPrice,
          stopLoss,
          targets: (tpResult?.targets || []).filter((t: any) => Number.isFinite(Number(t))).map((t: any) => Number(t)),
          distribution: riskConfig.tpDistribution,
          contractVolume,
          minOrderVolume,
          maxOrderVolume,
          baseVolume: contracts,
          riskAmount: sizingResult?.riskAmount || 0,
          maxPositionSize: riskConfig.maxPositionSize || 0,
          pricePrecision: marketInfo.pricePrecision,
          volumePrecision: marketInfo.amountPrecision,
      });

      if (legPlan.rejected) {
          logger.error(`CFD risk limit rejected: ${parsed.symbol}`, { strategyId, routeId, legPlan });
          if (strategyId) await this.services.auditService.log(strategyId, 'CFD_RISK_LIMIT_REJECTED', {
              message: `CFD 信号因风控约束被拒：${legPlan.rejectReason}`,
              symbol: parsed.symbol,
              side: parsed.side,
              legPlan,
          }, undefined, undefined, exchangeInstanceId);
          return null;
      }
      if (strategyId) await this.services.auditService.log(strategyId, 'CFD_LEG_PLAN', {
          symbol: parsed.symbol,
          side: parsed.side,
          legPlan,
      }, undefined, undefined, exchangeInstanceId);

      // 建腿组 + 每腿一行 Order + cfd_leg 明细（Order 表零改动，独立表关联）
      const legGroupId = `lg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const orderRecords: Order[] = [];
      const legRows: CfdLeg[] = [];
      await CfdLegGroup.create({
          id: legGroupId,
          orderRecordId: strategyId ? String(strategyId) : undefined,
          symbol: parsed.symbol,
          side: parsed.side,
          entryPrice: String(entryPrice),
          slPrice: formattedStopLoss || null,
          legCount: legPlan.legs.length,
          legPlan: JSON.stringify(legPlan),
          status: 'pending',
      });
      for (const leg of legPlan.legs) {
          const orderRecord = await Order.create({
              strategyId,
              routeId: routeId || null,
              source,
              symbol: parsed.symbol,
              side: parsed.side,
              amount: leg.volume,
              price: params.cmpEntry ? resolvedEntryPrice : (formattedEntryPrice || parsed.entryPrice),
              status: 'new',
              lifecycleStatus: 'INIT',
              type: orderType,
              leverage: targetLeverage,
              initialSl: formattedStopLoss,
              initialTp: leg.tpPrice || undefined,
              relatedMessages: JSON.stringify(strategyId ? [strategyId] : []),
              exchangeInstanceId,
              isSimulated: false,
              // 回测子进程：记录为对应 K 线/信号时间；实盘 nowOrSim() === new Date()
              createdAt: nowOrSim(),
              updatedAt: nowOrSim(),
          });
          orderRecords.push(orderRecord);
          const legRow = await CfdLeg.create({
              id: `${legGroupId}-${leg.legIndex}`,
              legGroupId,
              orderId: orderRecord.id,
              legIndex: leg.legIndex,
              tpPrice: leg.tpPrice || null,
              volume: leg.volume,
              positionId: null,
              status: 'pending',
          });
          legRows.push(legRow);
      }

      // 执行：单次 placeOrder 提交全部腿（适配器原子性：任一腿失败 → 全回滚）
      let entryResult: OrderResult;
      try {
          const orderParams: any = {
              symbol: parsed.symbol,
              side: parsed.side as 'buy' | 'sell',
              amount,
              type: orderType,
              price: formattedEntryPrice,
              stopLoss: formattedStopLoss,
              takeProfit: tpResult?.targets?.[0],
              text: `t-cfd-${orderRecords[0].id}`,
              legGroupId,
              cfdLegs: legPlan.legs.map((l) => ({
                  legIndex: l.legIndex,
                  volume: l.volume,
                  tpPrice: l.tpPrice || undefined,
                  priceSl: formattedStopLoss || undefined,
              })),
          };
          entryResult = await exchange.placeOrder(orderParams);
      } catch (error: any) {
          // 全腿标记 FAILED + 审计（仓位回滚已由适配器执行）
          for (const o of orderRecords) {
              await (Order as any).update(
                  { status: 'failed', lifecycleStatus: 'FAILED', response: JSON.stringify({ error: error.message }) },
                  { where: { id: o.id, lifecycleStatus: ['INIT', 'PENDING'] }, limit: 1 },
              );
          }
          await CfdLegGroup.update({ status: 'failed' }, { where: { id: legGroupId } });
          if (strategyId) await this.services.auditService.log(strategyId, 'CFD_LEG_ROLLBACK', formatError(error, {
              message: 'CFD 多腿下单失败，已执行全回滚',
              legGroupId,
          }), undefined, undefined, exchangeInstanceId);
          throw error;
      }

      // 回写每腿 exchangeOrderId + 成交确认（走 poller 轮询，替代 WS 回调）
      const legResults: any[] = (entryResult as any).legs || [];
      for (let i = 0; i < orderRecords.length; i++) {
          const orderRecord = orderRecords[i];
          const legResult = legResults[i] || {};
          const exchangeOrderId = String(legResult.orderId ?? entryResult.id);
          orderRecord.exchangeOrderId = exchangeOrderId;
          await orderRecord.save();
          try {
              // 市价腿短轮询（poller 默认 30s）、Trigger（限价）腿无限等待（对齐加密限价单语义）
              const fillWaitTimeout = orderType === 'limit' ? 0 : this.capabilities.getFillWaitTimeout(exchange);
              await exchange.waitForOrderFill(exchangeOrderId, parsed.symbol, fillWaitTimeout);
              // CFD 保护全部下单自带：成交确认后即可判定 PROTECTED（腿带 TP 或 SL）
              const leg = legPlan.legs[i];
              const hasProtection = !!leg.priceSl || !!leg.tpPrice;
              const newStatus = hasProtection ? 'PROTECTED' : 'OPEN';
              const [rows] = await (Order as any).update(
                  { lifecycleStatus: newStatus, status: 'finished' },
                  { where: { id: orderRecord.id, lifecycleStatus: ['INIT', 'PENDING'] }, limit: 1 },
              );
              if (rows > 0) {
                  await CfdLeg.update({ status: 'open' }, { where: { id: legRows[i].id } });
                  logger.info('CFD leg order lifecycle', { orderId: orderRecord.id, exchangeOrderId, toStatus: newStatus });
              }
          } catch (waitErr: any) {
              logger.warn(`CFD waitForOrderFill failed for leg ${orderRecord.id}`, formatError(waitErr));
          }
      }

      await CfdLegGroup.update({ status: 'filled' }, { where: { id: legGroupId } });
      if (strategyId) await this.services.auditService.log(strategyId, 'ORDER_PROTECTED', {
          message: 'CFD 多腿全部成交，保护已由交易所托管（priceTp/priceSl 下单自带）',
          legGroupId,
          legCount: orderRecords.length,
          symbol: parsed.symbol,
      }, orderRecords[0].id, 'PROTECTED', exchangeInstanceId);
      return entryResult;
  }

  private async prepareOpeningMarginAndLeverage(params: {
      exchange: any;
      symbol: string;
      marketInfo: { leverageMax?: string };
      position: Position | null;
  }): Promise<{ targetLeverage: string }> {
      const parsedMaxLeverage = Number.parseInt(params.marketInfo.leverageMax || '20', 10);
      const targetLeverage = Number.isFinite(parsedMaxLeverage) && parsedMaxLeverage > 0
          ? String(parsedMaxLeverage)
          : '20';

      // For Gate.io (and similar CEX), we always use Cross Margin (leverage=0).
      // Setting leverage to the target value first and then overriding to 0 in placeOrder()
      // causes two leverage changes, generating WS size=0 events that can trigger false
      // position-close detection. Set cross margin directly here instead.
      const currentLeverage = params.position?.leverage || '';
      const isAlreadyCross = currentLeverage === '0';

      if (!isAlreadyCross) {
          logger.info(`Setting cross margin for ${params.symbol}: Current=${currentLeverage || 'Unknown'}, Target=0 (cross)`);
          try {
              await params.exchange.setLeverage(params.symbol, '0');
          } catch (err: any) {
              // Gate.io rejects leverage change when holding a position in a different margin mode:
              // "can not switch isolated/cross margin when holding position"
              // This is expected when a position exists — the position is already in the correct
              // mode or the margin mode can't be changed. Continue with the current setting.
              if (err?.responseBody?.message?.includes('switch') || err?.label === 'POSITION_HOLDING') {
                  logger.info(`Cannot switch margin mode for ${params.symbol} (position exists), continuing with current setting`);
              } else {
                  logger.warn(`Failed to set cross margin for ${params.symbol}, continuing...`, { err });
              }
          }
      } else {
          logger.info(`Cross margin already set for ${params.symbol} (leverage=0), skipping update.`);
      }

      return { targetLeverage };
  }

  public async handleOpen(
    parsed: ParsedStrategy,
    riskConfig: StrategyRiskConfig,
    source: string,
    strategyId?: number,
    exchangeInstanceId?: string,
    routeId?: number
  ): Promise<OrderResult | null> {
    debugOrderOpen('started %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        source,
        parsed: summarizeParsedForDebug(parsed),
        riskConfig,
    });
    const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);
    const cmpEntry = isCmpEntryPrice(parsed.entryPrice);
    let normalizedParsed: ParsedStrategy;
    let staticOpenSignal: {
        symbol: string;
        side: 'buy' | 'sell';
        entryPrice: number;
        stopLoss: number;
        isLong: boolean;
        R: number;
    };
    let ticker: any;
    let markets: any[];

    if (cmpEntry) {
        const symbol = typeof parsed.symbol === 'string' ? parsed.symbol.trim() : '';
        if (!symbol) {
            await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: parsed.side,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: null,
                field: 'symbol',
                reason: 'Invalid open strategy symbol',
            });
        }
        if (parsed.side !== 'buy' && parsed.side !== 'sell') {
            await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: parsed.side,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: null,
                field: 'side',
                reason: 'Invalid open strategy side',
            });
        }

        [ticker, markets] = await Promise.all([
            exchange.getTicker(symbol),
            exchange.getMarkets(),
        ]);
        // ── syncCfdPrice：价格判断基准切换为 CFD 市场实时价（按 CFD 价格执行、无价差）──
        // 当路由配置 riskSettings.syncCfdPrice=true 时，CMP 解析 / 市价条件判断
        // 的 currentPrice 以 CFD（gate_tradfi）为准，而非 Lighter 等盘口价。
        if (riskConfig.syncCfdPrice === true) {
            const cfdPrice = await cfdPriceSyncService.getCfdLastPrice(symbol);
            if (cfdPrice !== null && cfdPrice > 0) {
                ticker = { ...(ticker || {}), lastPrice: String(cfdPrice), _cfdSynced: true };
                logger.info(`[syncCfdPrice] ${symbol} currentPrice overridden by CFD price: ${cfdPrice}`);
            } else {
                logger.warn(`[syncCfdPrice] ${symbol} CFD price unavailable, falling back to exchange ticker: ${ticker?.lastPrice}`);
            }
        }
        const currentPriceForCmp = parseFinitePositiveNumber(ticker?.lastPrice);
        if (currentPriceForCmp === null) {
            await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: parsed.side,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: currentPriceForCmp,
                field: 'currentPrice',
                reason: 'Invalid open strategy currentPrice',
            });
        }

        const resolvedCmpParsed = buildCmpResolvedOpenStrategy(parsed, currentPriceForCmp as number);
        if (!resolvedCmpParsed && riskConfig.riskMode !== 'ratio_based') {
            await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: parsed.side,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: currentPriceForCmp,
                field: 'stopLoss',
                reason: 'Invalid open strategy stopLoss',
            });
        }
        if (resolvedCmpParsed) {
            staticOpenSignal = await validateStaticOpenSignal(this.services.auditService, resolvedCmpParsed as ParsedStrategy, strategyId, exchangeInstanceId, riskConfig);
            normalizedParsed = {
                ...(resolvedCmpParsed as ParsedStrategy),
                symbol: staticOpenSignal.symbol,
            };
        } else {
            // ratio_based mode: stopLoss may be absent — use original parsed with current price as entry
            const fallbackParsed: ParsedStrategy = {
                ...parsed,
                entryPrice: formatExecutionNumber(currentPriceForCmp as number),
                orderType: 'market',
            };
            staticOpenSignal = await validateStaticOpenSignal(this.services.auditService, fallbackParsed, strategyId, exchangeInstanceId, riskConfig);
            normalizedParsed = {
                ...fallbackParsed,
                symbol: staticOpenSignal.symbol,
            };
        }
    } else {
        staticOpenSignal = await validateStaticOpenSignal(this.services.auditService, parsed, strategyId, exchangeInstanceId, riskConfig);
        normalizedParsed = {
            ...parsed,
            symbol: staticOpenSignal.symbol,
        };

        // 1. Fetch the minimum market data needed for hard validation.
        [ticker, markets] = await Promise.all([
            exchange.getTicker(normalizedParsed.symbol),
            exchange.getMarkets(),
        ]);
        // ── syncCfdPrice：非 CMP 静态信号同样用 CFD 价作为价格归一化基准 ──
        if (riskConfig.syncCfdPrice === true) {
            const cfdPrice = await cfdPriceSyncService.getCfdLastPrice(normalizedParsed.symbol);
            if (cfdPrice !== null && cfdPrice > 0) {
                ticker = { ...(ticker || {}), lastPrice: String(cfdPrice), _cfdSynced: true };
                logger.info(`[syncCfdPrice] ${normalizedParsed.symbol} currentPrice overridden by CFD price: ${cfdPrice}`);
            }
        }
    }

    const currentPriceForNormalization = parseFinitePositiveNumber(ticker?.lastPrice);
    const displayPriceNormalization = normalizeDisplayPriceScale({
        parsed: normalizedParsed,
        signal: staticOpenSignal,
        currentPrice: currentPriceForNormalization || 0,
    });
    if (displayPriceNormalization) {
        const originalEntryPrice = staticOpenSignal.entryPrice;
        const originalStopLoss = staticOpenSignal.stopLoss;
        normalizedParsed = displayPriceNormalization.parsed;
        staticOpenSignal = await validateStaticOpenSignal(this.services.auditService, normalizedParsed, strategyId, exchangeInstanceId, riskConfig);
        if (strategyId) {
            await this.services.auditService.log(
                strategyId,
                'STRATEGY_PRICE_SCALE_NORMALIZED',
                {
                    symbol: normalizedParsed.symbol,
                    side: normalizedParsed.side,
                    scaleFactor: displayPriceNormalization.scaleFactor,
                    currentPrice: currentPriceForNormalization,
                    originalEntryPrice,
                    normalizedEntryPrice: staticOpenSignal.entryPrice,
                    originalStopLoss,
                    normalizedStopLoss: staticOpenSignal.stopLoss,
                    originalTargets: parsed.targets,
                    normalizedTargets: normalizedParsed.targets,
                },
                undefined,
                undefined,
                exchangeInstanceId
            );
        }
        debugOrderOpen('display price scale normalized %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            scaleFactor: displayPriceNormalization.scaleFactor,
            originalEntryPrice,
            normalizedEntryPrice: staticOpenSignal.entryPrice,
            originalStopLoss,
            normalizedStopLoss: staticOpenSignal.stopLoss,
        });
    }
    const { marketInfo, currentPrice } =
        await validateOpenSignal(this.services.auditService, staticOpenSignal, ticker, markets, strategyId, exchangeInstanceId, riskConfig);
    const { entryPrice: validatedEntryPrice, stopLoss: validatedStopLoss, isLong, R } = staticOpenSignal;
    debugOrderOpen('open signal validated %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        side: normalizedParsed.side,
        entryPrice: validatedEntryPrice,
        stopLoss: validatedStopLoss,
        currentPrice,
        R,
        market: {
            symbol: marketInfo.symbol,
            leverageMax: marketInfo.leverageMax,
            amountPrecision: marketInfo.amountPrecision,
            pricePrecision: marketInfo.pricePrecision,
        },
    });

    const [balance, allPositions] = await Promise.all([
        exchange.getBalance(),
        exchange.getPositions().catch(() => [] as Position[])
    ]);

    // 2. Pre-check: OrderPreCheck (conflict, duplicate, stale)
    const preChecker = new OrderPreCheck(exchange, markets);
    const openOrders = await exchange.getOpenOrders(normalizedParsed.symbol);
    const activeDbOrders = await Order.findAll({
        where: {
            symbol: normalizedParsed.symbol,
            side: normalizedParsed.side,
            lifecycleStatus: ['INIT', 'PENDING', 'OPEN', 'PROTECTED'],
            // 回测导入的订单不参与实盘预检（子进程内订单未打标，行为不变）
            backtestRunId: { [Op.is]: null },
            ...(exchangeInstanceId ? { exchangeInstanceId } : {})
        }
    });
    debugOrderOpen('precheck inputs loaded %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        openOrderCount: openOrders.length,
        activeDbOrderCount: activeDbOrders.length,
        positionCount: allPositions.length,
    });

    // Cleanup stale orders
    await preChecker.cleanupStaleOrders(activeDbOrders, openOrders, allPositions);

    // Conflict check
    const conflictPos = await preChecker.checkConflict(normalizedParsed.symbol, normalizedParsed.side as 'buy' | 'sell');
    if (conflictPos) {
        if (riskConfig.autoCloseOppositePosition && !normalizedParsed.isAddPosition) {
            // Manual Intervention Detection: Check if conflict position is tracked
            const conflictSide = parseFloat(conflictPos.size) > 0 ? 'buy' : 'sell';
            const trackedConflictOrders = await Order.findAll({
                where: {
                    symbol: normalizedParsed.symbol,
                    side: conflictSide,
                    lifecycleStatus: ['OPEN', 'PROTECTED'],
                    backtestRunId: { [Op.is]: null },
                    ...(exchangeInstanceId ? { exchangeInstanceId } : {})
                }
            });

            if (trackedConflictOrders.length === 0) {
                logger.error(`Manual intervention detected: Opposite ${conflictSide} position exists for ${normalizedParsed.symbol} but no tracked orders found. Refusing to close manual position and open ${normalizedParsed.side}.`, {
                    strategyId,
                    routeId,
                    exchangeInstanceId,
                    symbol: normalizedParsed.symbol,
                    requestedSide: normalizedParsed.side,
                    conflictSide,
                });
                if (strategyId) await this.services.auditService.log(strategyId, 'MANUAL_INTERVENTION_BLOCKED', {
                    message: `Blocked auto-close of manual ${conflictSide} position and opening ${normalizedParsed.side}`
                });
                return null;
            }

            logger.warn(`Conflict detected: Holding ${conflictPos ? (parseFloat(conflictPos.size) > 0 ? 'buy' : 'sell') : ''} position for ${normalizedParsed.symbol} while requesting ${normalizedParsed.side}. Closing conflict (autoCloseOppositePosition=true)...`);
            debugOrderOpen('conflict detected, closing opposite position %o', {
                strategyId,
                routeId,
                exchangeInstanceId,
                symbol: normalizedParsed.symbol,
                requestedSide: normalizedParsed.side,
                conflictPosition: conflictPos,
            });
            if (strategyId) await this.services.auditService.log(strategyId, 'CONFLICT_RESOLUTION', { message: `Closing existing opposite position before opening ${normalizedParsed.side}` });

            const oppositeSide = normalizedParsed.side === 'buy' ? 'sell' : 'buy';
            await this.closePositionService.handleClose(normalizedParsed, source, riskConfig, strategyId, oppositeSide as 'buy' | 'sell', exchangeInstanceId);
        } else {
            logger.info(`Conflict detected: Holding opposite position for ${normalizedParsed.symbol} while requesting ${normalizedParsed.side}. Ignoring conflict (autoCloseOppositePosition=false).`);
            debugOrderOpen('conflict detected but ignored %o', {
                strategyId,
                routeId,
                exchangeInstanceId,
                symbol: normalizedParsed.symbol,
                requestedSide: normalizedParsed.side,
                conflictPosition: conflictPos,
            });
            if (strategyId) await this.services.auditService.log(strategyId, 'CONFLICT_IGNORED', { message: `Holding opposite position while opening ${normalizedParsed.side}. Auto-close disabled.` });
        }
    }

    // Determine active position for leverage check
    const symbolPositions = allPositions.filter(p => p.symbol === normalizedParsed.symbol && parseFloat(p.size) !== 0);
    const sameSidePos = symbolPositions.find(p => {
        const size = parseFloat(p.size);
        return normalizedParsed.side === 'buy' ? size > 0 : size < 0;
    });
    const position = sameSidePos || symbolPositions[0] || null;

    // Mark symbol as pending open so WSEventRouter doesn't misinterpret
    // transient size=0 (from leverage/margin mode changes) as a position close.
    const pendingOpenSymbols: Set<string> | undefined = exchange.pendingOpenSymbols;
    pendingOpenSymbols?.add(normalizedParsed.symbol);
    try {

    // 3. Margin / Leverage Logic
    // CFD：平台固定杠杆，API 不可调 → 短路（杠杆仅用于 Order 记录展示，取品种规格 leverage）
    const isCfd = this.isGateCfdExchange(exchange);
    const { targetLeverage } = isCfd
        ? { targetLeverage: marketInfo.leverageMax || '100' }
        : await this.prepareOpeningMarginAndLeverage({
            exchange,
            symbol: normalizedParsed.symbol,
            marketInfo,
            position,
        });

    // 4. Price Adjustments (Padding/Slippage)
    // 两套互斥体系（riskConfig.paddingMode）：
    //   'r'（默认）  : R 百分比滑点（entryPaddingR/tpPaddingR/slPaddingR），历史行为不变；
    //   'fixed'     : 固定美元体系（让点入场/固定止损距离/止损后移），R 滑点全部忽略。
    // fixed 模式：TP 也保持信号原值（R 百分比 TP 滑点随体系整体忽略）
    const tpPaddingR = riskConfig.paddingMode === 'fixed'
        ? 0
        : (riskConfig.tpPaddingR ?? config.trading.execution.defaultPaddingR.tp);
    const originalEntryPrice = validatedEntryPrice;
    const originalStopLoss = validatedStopLoss;
    let takeProfit = normalizedParsed.targets && normalizedParsed.targets.length > 0 ? parseFloat(normalizedParsed.targets[0]) : undefined;

    logger.info(`Original Strategy: ${normalizedParsed.side} @ ${originalEntryPrice}, SL: ${originalStopLoss}, TP: ${takeProfit}, R=${R.toFixed(4)}`);

    const adjustment = applyOpenPriceAdjustments({
        side: normalizedParsed.side as 'buy' | 'sell',
        entryPrice: originalEntryPrice,
        stopLoss: originalStopLoss,
        takeProfit,
        R,
        currentPrice,
        riskConfig,
        defaults: config.trading.execution.defaultPaddingR,
    });
    if (adjustment.invalidReason) {
        await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
            symbol: normalizedParsed.symbol,
            side: normalizedParsed.side,
            entryPrice: normalizedParsed.entryPrice,
            stopLoss: normalizedParsed.stopLoss,
            currentPrice,
            field: 'priceAdjustment',
            reason: `Invalid open strategy price adjustment: ${adjustment.invalidReason}`,
        });
    }
    const entryPrice = adjustment.entryPrice;
    const stopLoss = adjustment.stopLoss;
    takeProfit = adjustment.takeProfit;

    logger.info(`Adjusted Strategy (mode=${adjustment.mode}): Entry: ${entryPrice.toFixed(4)}, SL: ${stopLoss.toFixed(4)}, TP: ${takeProfit?.toFixed(4)}`, {
        applied: adjustment.applied,
    });
    debugOrderOpen('price adjustments applied %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        mode: adjustment.mode,
        applied: adjustment.applied,
        originalEntryPrice,
        adjustedEntryPrice: entryPrice,
        originalStopLoss,
        adjustedStopLoss: stopLoss,
        adjustedTakeProfit: takeProfit,
    });

    // 5. Order Type Selection
    let orderType: 'limit' | 'market' = 'limit';
    let orderPrice: string | undefined = entryPrice.toString();
    const entryOrderMode: 'maker' | 'taker' = riskConfig.entryOrderMode === 'maker' ? 'maker' : 'taker';
    const toleranceR = riskConfig.priceTolerance || 0.01; // Default 0.01R
    const tolerance = R * toleranceR; // Convert R multiplier to absolute price tolerance

    // Market Order Condition
    let isMarket = false;
    if (isLong) {
        if (currentPrice <= entryPrice) {
            isMarket = true;
        } else if ((currentPrice - entryPrice) <= tolerance) {
            isMarket = true;
        }
    } else {
        if (currentPrice >= entryPrice) {
            isMarket = true;
        } else if ((entryPrice - currentPrice) <= tolerance) {
            isMarket = true;
        }
    }

    if (cmpEntry) {
        orderType = 'market';
        orderPrice = undefined;
        logger.info(`CMP entry forced MARKET order. Current: ${currentPrice}`);
    } else if (isMarket) {
        orderType = 'market';
        orderPrice = undefined;
        logger.info(`Price condition met for MARKET order. Current: ${currentPrice}, Target: ${entryPrice}, Tolerance: ${tolerance.toFixed(4)} (${toleranceR}R)`);
    } else {
        logger.info(`Price outside tolerance, using LIMIT order. Current: ${currentPrice}, Target: ${entryPrice}, Tolerance: ${tolerance.toFixed(4)} (${toleranceR}R)`);
    }

    const entryPostOnly = orderType === 'limit' && entryOrderMode === 'maker';
    if (orderType === 'limit') {
        logger.info(`Entry limit mode: ${entryOrderMode}${entryPostOnly ? ' (postOnly enabled)' : ''}`);
    }
    debugOrderOpen('entry order type resolved %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        orderType,
        orderPrice,
        entryOrderMode,
        entryPostOnly,
        currentPrice,
        targetEntryPrice: entryPrice,
        tolerance,
        toleranceR,
        cmpEntry,
    });
    logger.info('Entry order type resolved', {
      orderType, currentPrice, entryPrice, cmpEntry, tolerance,
    });

    // 6. Duplicate Check
    let duplicateOrder: any = undefined;
    try {
        // Re-fetch active DB orders after cleanup (they may have changed)
        // Strategy C fix: exclude INIT/PENDING from the query to prevent same-batch sibling strategies
        // from being flagged as duplicates (e.g. CMP leg blocking CMP-till-limit leg)
        const refreshedDbOrders = await Order.findAll({
            where: {
                symbol: normalizedParsed.symbol,
                side: normalizedParsed.side,
                lifecycleStatus: ['OPEN', 'PROTECTED'],
                backtestRunId: { [Op.is]: null },
                ...(exchangeInstanceId ? { exchangeInstanceId } : {})
            }
        });

        const dupResult = await preChecker.checkDuplicate(
            normalizedParsed.symbol,
            normalizedParsed.side as 'buy' | 'sell',
            entryPrice,
            stopLoss,
            openOrders,
            refreshedDbOrders,
            orderType
        );

        if (dupResult.isDuplicate) {
            duplicateOrder = { id: dupResult.existingOrderId, status: 'exchange-duplicate' };
        }
        debugOrderOpen('duplicate check completed %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            isDuplicate: dupResult.isDuplicate,
            existingOrderId: dupResult.existingOrderId,
        });
    } catch (dupErr) {
        logger.warn(`Failed to check for duplicates: ${dupErr}`, { error: dupErr });
        debugOrderOpen('duplicate check failed %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            error: (dupErr as any)?.message || String(dupErr),
        });
    }

    if (duplicateOrder) {
        logger.warn(`Skipping duplicate order for ${normalizedParsed.symbol}: ${normalizedParsed.side} @ ${orderPrice || 'MARKET'} (Existing ID: ${duplicateOrder.id})`);
        debugOrderOpen('skipped duplicate order %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            duplicateOrder,
        });
        return {
            id: duplicateOrder.id,
            status: 'skipped_duplicate',
            symbol: normalizedParsed.symbol,
            amount: duplicateOrder.amount || '0',
            price: duplicateOrder.price || '0',
            text: 'Duplicate detected'
        };
    }

    // 7. Position Sizing using PositionSizer
    const sizingResult = new PositionSizer().calculate({
        balance,
        market: marketInfo,
        entryPrice,
        stopLoss,
        riskConfig,
        weight: normalizedParsed.weight,
        averageEntryPrice: normalizedParsed.averageEntryPrice,
        quantity: normalizedParsed.quantity,
    });

    // 跨交易所乘数安全防护：同一 riskValue 在不同交易所（乘数/精度不同）换算后，
    // 实际风险敞口不得超出设定预算。floor 取整语义下理论不会触发，此处为回归兜底；
    // underfunded（预算不足已升格到最小单位）属于有意放大，不视为风险突破。
    if (riskConfig.riskMode !== 'ratio_based'
        && sizingResult.riskAmount > 0
        && sizingResult.actualRisk > sizingResult.riskAmount * 1.001
        && !sizingResult.underfunded) {
        logger.warn(`Position sizing risk breach: actual risk ${sizingResult.actualRisk.toFixed(2)} USDT exceeds configured ${sizingResult.riskAmount} USDT`, {
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            configuredRisk: sizingResult.riskAmount,
            actualRisk: sizingResult.actualRisk,
            contracts: sizingResult.contracts,
            multiplier: marketInfo.multiplier,
            amountPrecision: marketInfo.amountPrecision,
        });
        if (strategyId) {
            await this.services.auditService.log(
                strategyId,
                'POSITION_SIZE_RISK_BREACH',
                {
                    configuredRisk: sizingResult.riskAmount,
                    actualRisk: sizingResult.actualRisk,
                    contracts: sizingResult.contracts,
                    multiplier: marketInfo.multiplier,
                    amountPrecision: marketInfo.amountPrecision,
                    entryPrice,
                    stopLoss,
                },
                undefined,
                undefined,
                exchangeInstanceId
            );
        }
    }

    let contracts = sizingResult.contracts;
    let amount = sizingResult.amount;

    // Apply risk multiplier (clamp to 0.01-10 range)
    const riskMultiplier = Math.max(0.01, Math.min(10, parsed.riskMultiplier ?? 1));
    if (riskMultiplier !== 1) {
        contracts = roundToPrecision(contracts * riskMultiplier, marketInfo.amountPrecision);
        amount = contracts.toString();
        logger.info(`Risk multiplier applied: ${riskMultiplier}x (Original: ${sizingResult.contracts}, Final: ${contracts})`);
    }

    if ((parsePositiveAmount(amount) || 0) <= 0) {
        logger.error('Calculated amount <= 0, rejecting order instead of defaulting to 1');
        await rejectOpenStrategy(this.services.auditService, strategyId, exchangeInstanceId, {
            symbol: normalizedParsed.symbol,
            side: normalizedParsed.side,
            entryPrice: normalizedParsed.entryPrice,
            stopLoss: normalizedParsed.stopLoss,
            currentPrice: null,
            field: 'amount',
            reason: `Calculated position size is zero or negative: amount=${amount}, contracts=${contracts}`,
        });
    }

    // 预算不足已升格到最小单位：记录实际风险敞口，供事后审计
    if (sizingResult.underfunded) {
        logger.warn(`Position sizing underfunded: risk budget ${sizingResult.underfunded.riskAmount} USDT below minimum tradable size risk ${sizingResult.underfunded.minUnitRisk.toFixed(2)} USDT. Upgraded to min unit ${sizingResult.underfunded.minUnit} contract. Actual risk: ${sizingResult.actualRisk.toFixed(2)} USDT.`, {
            routeId,
            exchangeInstanceId,
            symbol: normalizedParsed.symbol,
            configuredRisk: sizingResult.underfunded.riskAmount,
            minUnitRisk: sizingResult.underfunded.minUnitRisk,
            actualRisk: sizingResult.actualRisk,
            contracts: sizingResult.contracts,
            multiplier: sizingResult.underfunded.multiplier,
            amountPrecision: marketInfo.amountPrecision,
        });
        if (strategyId) {
            await this.services.auditService.log(
                strategyId,
                'POSITION_SIZE_UNDERFUNDED_UPGRADED',
                {
                    configuredRisk: sizingResult.underfunded.riskAmount,
                    minUnitRisk: sizingResult.underfunded.minUnitRisk,
                    actualRisk: sizingResult.actualRisk,
                    contracts: sizingResult.contracts,
                    multiplier: sizingResult.underfunded.multiplier,
                    amountPrecision: marketInfo.amountPrecision,
                    entryPrice,
                    stopLoss,
                },
                undefined,
                undefined,
                exchangeInstanceId
            );
        }
    }
    debugOrderOpen('position size calculated %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        sizingResult,
        riskMultiplier,
        finalContracts: contracts,
        finalAmount: amount,
    });
    logger.info('Position size calculated', {
      contracts, finalAmount: amount, riskMultiplier,
      sizingMode: riskConfig.positionSizingMode,
      configuredRisk: sizingResult.riskAmount,
      actualRisk: sizingResult.actualRisk,
    });

    // 8. TP/SL Calculation using TpSlCalculator
    const tpResult = new TpSlCalculator().calculate(
        {
            entryPrice,
            stopLoss,
            side: normalizedParsed.side as 'buy' | 'sell',
            targets: normalizedParsed.targets || [],
            tpDistribution: riskConfig.tpDistribution,
            tpPaddingR,
            tpOrderType: riskConfig.tpOrderType,
            fixedRiskRewardClose: riskConfig.fixedRiskRewardClose,
        },
        parseFloat(amount),
        marketInfo.pricePrecision,
        marketInfo.amountPrecision
    );

    logger.info(`Placing Order: ${normalizedParsed.symbol} ${normalizedParsed.side} x ${amount} @ ${orderType === 'market' ? 'MKT' : entryPrice.toFixed(marketInfo.pricePrecision)}`);
    debugOrderOpen('tp/sl calculated %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        tpResult,
    });
    logger.info('TP/SL calculated', {
      slPrice: stopLoss, tpTargets: tpResult.targets,
      tpDistribution: riskConfig.tpDistribution,
    });

    // Format prices according to market precision
    const formattedEntryPrice = orderType === 'limit' ? entryPrice.toFixed(marketInfo.pricePrecision) : undefined;
    const resolvedEntryPrice = entryPrice.toFixed(marketInfo.pricePrecision);
    // P1-4: 只有 SL 为有限正数时才计算 formattedStopLoss。
    // ratio_based 无 SL 时 validatedStopLoss 为 0，直接 toFixed 会产生
    // "-12.34" 这类垃圾值并被写进 initialSl / PendingProtection，
    // 导致 PostFillOrchestrator（以 initialSl 为准）尝试挂无效 SL。
    const hasValidStopLoss = Number.isFinite(stopLoss) && stopLoss > 0;
    const formattedStopLoss = hasValidStopLoss ? stopLoss.toFixed(marketInfo.pricePrecision) : undefined;

    // ── CFD 分支（多 TP = 多仓分腿，保护全部下单时自带，无 post-fill）──
    if (this.isGateCfdExchange(exchange)) {
        return this.handleCfdOpen({
            exchange,
            parsed: normalizedParsed,
            riskConfig,
            source,
            strategyId,
            exchangeInstanceId,
            routeId,
            marketInfo,
            ticker,
            currentPrice,
            cmpEntry,
            orderType,
            formattedEntryPrice,
            resolvedEntryPrice,
            formattedStopLoss,
            hasValidStopLoss,
            entryPrice,
            stopLoss,
            amount,
            contracts,
            sizingResult,
            tpResult,
            targetLeverage,
        });
    }

    // Gate v4.106.86+ 订单自带 TP/SL（gate-api >= 7.2.100）：
    // - 单 TP + 有 SL：入场单同时自带 TP 与 SL（tpsl_tp_trigger_price + tpsl_sl_trigger_price），
    //   成交后由交易所托管保护，post-fill 不再挂任何单。
    // - 多 TP + 有 SL：入场单只带 SL（消除「成交→挂 SL」裸仓竞态窗口），
    //   多档 TP 由 post-fill 按分档挂 reduce-only 限价单（自带 TP 是订单级全平，
    //   与分档 TP 语义冲突，不做过渡 TP）。
    // - 无 SL（ratio_based）：不启用自带保护，保持原有 post-fill 流程。
    // Lighter 交易所不支持 tpsl 字段，走原逻辑。
    const supportsTpsl = !this.isLighterExchange(exchange);
    // 实际挂单 TP 数（TpSlCalculator 可能因金额过小把多档降级为单 TP）。
    const tpCount = tpResult.tpOrders.length;
    const tpslSlTriggerPrice = supportsTpsl && hasValidStopLoss ? formattedStopLoss : undefined;
    const tpslTpTriggerPrice = supportsTpsl && hasValidStopLoss && tpCount === 1 ? tpResult.tpOrders[0]?.price : undefined;
    debugOrderOpen('tpsl decision %o', {
        strategyId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        supportsTpsl,
        hasValidStopLoss,
        tpCount,
        tpslSlTriggerPrice,
        tpslTpTriggerPrice,
    });

    // 9. Create Order Record
    const orderRecord = await Order.create({
        strategyId: strategyId,
        routeId: routeId || null,
        source,
        symbol: normalizedParsed.symbol,
        side: normalizedParsed.side,
        amount: amount,
        price: cmpEntry ? resolvedEntryPrice : (formattedEntryPrice || normalizedParsed.entryPrice),
        status: 'new',
        lifecycleStatus: 'INIT',
        type: orderType,
        leverage: targetLeverage,
        initialSl: formattedStopLoss,
        initialTp: tpResult.targets[0] || undefined,
        relatedMessages: JSON.stringify(strategyId ? [strategyId] : []),
        exchangeInstanceId: exchangeInstanceId,
        isSimulated: false
    });
    await this.services.orderPersistenceHandler.upsertStrategyPositionFromOrder(orderRecord, undefined);
    await this.capabilities.persistSoftStopLossIfPresent({
        strategyId,
        orderId: orderRecord.id,
        source,
        parserName: normalizedParsed.raw?.parserName || normalizedParsed.raw?.neil?.parserName || undefined,
        exchangeInstanceId,
        parsed: normalizedParsed,
    });
    debugOrderOpen('order record created %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        orderId: orderRecord.id,
        symbol: normalizedParsed.symbol,
        side: normalizedParsed.side,
        amount,
        orderType,
        formattedEntryPrice,
        formattedStopLoss,
    });

    if (strategyId) await this.services.auditService.log(strategyId, 'ORDER_INIT', {
        orderId: orderRecord.id,
        symbol: normalizedParsed.symbol,
        side: normalizedParsed.side,
        size: amount,
        price: orderPrice,
        type: orderType,
        leverage: targetLeverage,
        exchangeInstanceId,
        currentPrice,
        entryOrderMode,
        postOnly: entryPostOnly
    });

    if (strategyId) await this.services.auditService.log(strategyId, 'SUBMITTING_ORDER', {
        symbol: normalizedParsed.symbol,
        side: normalizedParsed.side,
        size: amount,
        price: orderPrice,
        type: orderType,
        postOnly: entryPostOnly,
        entryOrderMode,
        orderId: orderRecord.id
    });

    // 10. Execute Order
    let entryResult: OrderResult;
    try {
        debugOrderOpen('placing exchange order %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            orderId: orderRecord.id,
            symbol: normalizedParsed.symbol,
            side: normalizedParsed.side,
            amount,
            price: formattedEntryPrice,
            type: orderType,
            postOnly: entryPostOnly || undefined,
        });
        const orderParams: any = {
            symbol: normalizedParsed.symbol,
            side: normalizedParsed.side as 'buy' | 'sell',
            amount: amount,
            price: formattedEntryPrice,
            type: orderType,
            postOnly: entryPostOnly || undefined,
            stopLoss: formattedStopLoss,
            takeProfit: tpResult.targets[0],
            tpOrders: tpResult.tpOrders,
            text: `t-entry-${orderRecord.id}`,
            // Gate 订单自带 TP/SL：由 placeOrder 透传 tpsl_tp_trigger_price / tpsl_sl_trigger_price。
            tpslTpTriggerPrice,
            tpslSlTriggerPrice,
        };

        if (this.isLighterExchange(exchange)) {
            const leverageNum = parseFloat(targetLeverage);
            orderParams.marginContext = {
                leverage: Number.isFinite(leverageNum) && leverageNum > 0 ? leverageNum : parseFloat(marketInfo.leverageMax || '20'),
                availableBalance: parseFloat(balance.available),
                position: position,
            };
        }

        entryResult = await exchange.placeOrder(orderParams);

        orderRecord.exchangeOrderId = entryResult.id;
        orderRecord.status = entryResult.status;
        orderRecord.lifecycleStatus = isFilledOrderStatus(entryResult.status) ? 'OPEN' : 'PENDING';
        if (isFilledOrderStatus(entryResult.status)) {
            orderRecord.filledAmount = entryResult.amount || amount;
            orderRecord.filledPrice = entryResult.price || (orderType === 'market' ? ticker.lastPrice : formattedEntryPrice!);
            if (cmpEntry && orderRecord.filledPrice) {
                orderRecord.price = orderRecord.filledPrice;
            }
        }
        await orderRecord.save();
        await this.services.orderPersistenceHandler.upsertStrategyPositionFromOrder(orderRecord, undefined);
        logger.info('Order lifecycle status changed', {
          orderId: orderRecord.id,
          exchangeOrderId: entryResult.id,
          fromStatus: 'INIT',
          toStatus: orderRecord.lifecycleStatus,
          reason: orderRecord.lifecycleStatus === 'OPEN' ? 'exchange order filled immediately' : 'exchange order submitted',
        });
        debugOrderOpen('exchange order placed %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            orderId: orderRecord.id,
            exchangeOrderId: entryResult.id,
            status: entryResult.status,
            lifecycleStatus: orderRecord.lifecycleStatus,
            amount: entryResult.amount,
            price: entryResult.price,
        });

    } catch (error: any) {
        orderRecord.status = 'failed';
        orderRecord.lifecycleStatus = 'FAILED';
        orderRecord.response = JSON.stringify({ error: error.message });
        await orderRecord.save();

        logger.info('Order lifecycle status changed', {
          orderId: orderRecord.id,
          fromStatus: 'INIT',
          toStatus: 'FAILED',
          reason: 'exchange order rejected',
        });
        if (strategyId) await this.services.auditService.log(strategyId, 'ORDER_PLACEMENT_FAILED', formatError(error, { orderId: orderRecord.id, symbol: normalizedParsed.symbol, side: normalizedParsed.side }), orderRecord.id, 'FAILED', exchangeInstanceId);
        debugOrderOpen('exchange order placement failed %o', {
            strategyId,
            routeId,
            exchangeInstanceId,
            orderId: orderRecord.id,
            symbol: normalizedParsed.symbol,
            ...formatError(error),
        });
        throw error;
    }

    const isFilled = isFilledOrderStatus(entryResult.status);

    // 11. Post-Fill: Place SL and TP
    if (entryResult && entryResult.id) {
        const handlePostFill = async (filledDetails?: any) => {
             // P1-5: 状态升级统一走条件更新，绝不从 PROTECTED 降级。
             // WS persistence handler 可能已把订单置为 PROTECTED，REST 串行路径
             // 用过期内存对象覆盖会把它打回 OPEN/PENDING。
             const applyLifecycleStatus = async (status: Order['lifecycleStatus']) => {
                 const [rows] = await (Order as any).update(
                     { lifecycleStatus: status },
                     { where: { id: orderRecord.id, lifecycleStatus: ['INIT', 'PENDING', 'OPEN'] }, limit: 1 }
                 );
                 if (rows > 0) {
                     orderRecord.lifecycleStatus = status;
                 } else {
                     try { await orderRecord.reload(); } catch { /* 保持内存状态 */ }
                 }
             };

             // Ensure status is OPEN (filled)
             if (orderRecord.lifecycleStatus !== 'OPEN') {
                 const prevStatus = orderRecord.lifecycleStatus;
                 const updates: any = { status: 'finished' };
                 if (filledDetails) {
                     updates.filledAmount = filledDetails.amount;
                     updates.filledPrice = filledDetails.price;
                 }
                 // P1-5: 用条件更新替代「先 save 再 transition」，
                 // 避免过期内存对象把 WS 路径已置的 PROTECTED 覆盖回 PENDING。
                 const [rows] = await (Order as any).update(
                     updates,
                     { where: { id: orderRecord.id, lifecycleStatus: ['INIT', 'PENDING'] }, limit: 1 }
                 );
                 if (rows === 0) {
                     logger.warn('Concurrent transition detected, aborting handlePostFill', { orderId: orderRecord.id });
                     try { await orderRecord.reload(); } catch { /* ignore */ }
                     return;
                 }
                 Object.assign(orderRecord, updates);
                 orderRecord.lifecycleStatus = 'OPEN';
                 logger.info('Order lifecycle status changed', {
                     orderId: orderRecord.id,
                     exchangeOrderId: orderRecord.exchangeOrderId,
                     fromStatus: prevStatus,
                     toStatus: 'OPEN',
                     reason: 'order filled via WS/waitForFill',
                 });
             }

             // Use PostFillOrchestrator for SL + TP placement
             const pipeline = this.services.protectionContext.getProtectionPipeline(exchangeInstanceId);
             const orchestrator = this.services.protectionContext.createPostFillOrchestrator(exchange, this.capabilities.noStopLossMonitor, this.capabilities);

             // P0-2: 部分成交时按实际成交量缩放 TP 数量，避免 reduce-only TP 总量超过持仓。
             const requestedAmount = parseFloat(amount) || 0;
             const actualFilledQty = parseFloat(orderRecord.filledAmount || orderRecord.amount || '0') || 0;
             let tpOrdersToPlace = tpResult.tpOrders;
             if (requestedAmount > 0 && actualFilledQty > 0 && actualFilledQty < requestedAmount - 1e-8) {
                 const scale = actualFilledQty / requestedAmount;
                 tpOrdersToPlace = tpResult.tpOrders.map(tp => ({
                     ...tp,
                     amount: roundToPrecision(parseFloat(tp.amount) * scale, marketInfo.amountPrecision).toString(),
                 }));
                 logger.info(`Partial fill detected (filled=${actualFilledQty}/${requestedAmount}), scaling TP amounts by ${scale.toFixed(4)}`);
             }

             const stopLossValue = parseFinitePositiveNumber(normalizedParsed.stopLoss);
             if (stopLossValue != null && stopLossValue > 0) {
                 const { slPlaced, tpPlaced } = await orchestrator.run({
                     order: orderRecord,
                     parsed: normalizedParsed,
                     riskConfig,
                     source,
                     strategyId,
                     exchangeInstanceId,
                     tpOrders: tpOrdersToPlace,
                     // 入场单自带保护：SL 已通过 tpsl_sl_trigger_price 托管，TP 在单 TP 场景
                     // 通过 tpsl_tp_trigger_price 托管 —— 管线不得重复挂单。
                     slPreAttached: !!tpslSlTriggerPrice,
                     tpPreAttached: !!tpslTpTriggerPrice,
                 });

                 const newStatus = slPlaced && tpPlaced ? 'PROTECTED' : 'OPEN';
                 await applyLifecycleStatus(newStatus);
                 logger.info('Order lifecycle status changed', {
                   orderId: orderRecord.id,
                   exchangeOrderId: orderRecord.exchangeOrderId,
                   fromStatus: 'OPEN',
                   toStatus: newStatus,
                   reason: 'post-fill SL/TP placement',
                   slPlaced,
                   tpPlaced,
                 });
                 if (strategyId && newStatus === 'PROTECTED') {
                     await this.services.auditService.log(strategyId, 'ORDER_PROTECTED', { orderId: orderRecord.id }, orderRecord.id, 'PROTECTED', exchangeInstanceId);
                 }
                 debugOrderOpen('post-fill handling completed %o', {
                     strategyId,
                     routeId,
                     exchangeInstanceId,
                     orderId: orderRecord.id,
                     exchangeOrderId: orderRecord.exchangeOrderId,
                     slPlaced,
                     tpPlaced,
                     lifecycleStatus: orderRecord.lifecycleStatus,
                 });
             } else {
                 logger.info(`No stop loss for ratio_based order, skipping stop loss placement`);
                 // Still place TP if available
                 if (tpOrdersToPlace && tpOrdersToPlace.length > 0) {
                     const { slPlaced, tpPlaced } = await orchestrator.run({
                         order: orderRecord,
                         parsed: normalizedParsed,
                         riskConfig,
                         source,
                         strategyId,
                         exchangeInstanceId,
                         tpOrders: tpOrdersToPlace,
                     });
                     const newStatus = tpPlaced ? 'PROTECTED' : 'OPEN';
                     await applyLifecycleStatus(newStatus);
                     logger.info('Order lifecycle status changed', {
                       orderId: orderRecord.id,
                       exchangeOrderId: orderRecord.exchangeOrderId,
                       fromStatus: 'OPEN',
                       toStatus: newStatus,
                       reason: 'post-fill TP placement (no SL)',
                       slPlaced: false,
                       tpPlaced,
                     });
                 } else {
                     await applyLifecycleStatus('OPEN');
                     logger.info('Order lifecycle status changed', {
                       orderId: orderRecord.id,
                       exchangeOrderId: orderRecord.exchangeOrderId,
                       fromStatus: 'OPEN',
                       toStatus: 'OPEN',
                       reason: 'post-fill no SL/TP targets',
                       slPlaced: false,
                       tpPlaced: false,
                     });
                 }
                 debugOrderOpen('post-fill handling completed (no SL) %o', {
                     strategyId,
                     routeId,
                     exchangeInstanceId,
                     orderId: orderRecord.id,
                     exchangeOrderId: orderRecord.exchangeOrderId,
                     lifecycleStatus: orderRecord.lifecycleStatus,
                 });
             }
        };

        if (isFilled) {
             // P0-2: finished 但零成交（IOC 未成交，left=size）时跳过 post-fill：
             // 仓位不存在，WS handler 会把订单标记为 cancelled/CLOSED。
             const filledQty = parseFloat(orderRecord.filledAmount || '0') || 0;
             if (filledQty > 0) {
                 await handlePostFill(entryResult);
             } else {
                 logger.warn(`Order ${entryResult.id} finished with zero fill (IOC unmatched) — skipping post-fill`);
                 debugOrderOpen('zero-fill finished order skipped post-fill %o', {
                     strategyId,
                     routeId,
                     exchangeInstanceId,
                     orderId: orderRecord.id,
                     exchangeOrderId: entryResult.id,
                 });
             }
        } else {
            logger.info(`Order ${entryResult.id} is pending. Waiting for fill via WS...`);
            debugOrderOpen('order pending, waiting for websocket fill %o', {
                strategyId,
                routeId,
                exchangeInstanceId,
                orderId: orderRecord.id,
                exchangeOrderId: entryResult.id,
            });

            // P0-1: 限价单挂单可能长时间不成交，timeoutMs=0 表示无限等待（纯 WS 监听），
            // 不再在 60s 后误标 RISK_UNPROTECTED；市价单保留默认超时（REST 兜底）。
            const fillWaitTimeout = orderType === 'limit' ? 0 : this.capabilities.getFillWaitTimeout(exchange);
            exchange.waitForOrderFill(entryResult.id, normalizedParsed.symbol, fillWaitTimeout)
                .then(async (filledOrder) => {
                     await this.capabilities.runWithStrategyTrace(strategyId, async () => {
                         logger.info(`Order ${filledOrder.id} filled (WS)! Executing Post-Fill Logic...`);
                         debugOrderOpen('websocket fill received %o', {
                            strategyId,
                            routeId,
                            exchangeInstanceId,
                            orderId: orderRecord.id,
                            filledOrder,
                         });
                         await handlePostFill(filledOrder);
                     });
                })
                .catch(async (err) => {
                    await this.capabilities.runWithStrategyTrace(strategyId, async () => {
                        logger.warn(`Order ${entryResult.id} monitor ended/timed out`, formatError(err));
                        debugOrderOpen('websocket fill monitor ended %o', {
                            strategyId,
                            routeId,
                            exchangeInstanceId,
                            orderId: orderRecord.id,
                            exchangeOrderId: entryResult.id,
                            ...formatError(err),
                        });
                        const [affectedRows] = await (Order as any).update(
                          { lifecycleStatus: 'RISK_UNPROTECTED' },
                          { where: { id: orderRecord.id, lifecycleStatus: 'PENDING' }, limit: 1 }
                        );
                        if (affectedRows > 0) {
                          logger.error(`Order ${orderRecord.id} marked as RISK_UNPROTECTED — PostFill failed or timed out`);
                          if (this.services.auditService && strategyId) {
                            await this.services.auditService.log(strategyId, 'POSTFILL_FAILED', formatError(err, {
                              orderId: orderRecord.id,
                              exchangeOrderId: entryResult.id,
                            }), undefined, exchangeInstanceId);
                          }
                        }
                    });
                });

        }
    }

    debugOrderOpen('completed %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: normalizedParsed.symbol,
        result: entryResult,
    });
    return entryResult;

    } finally {
      pendingOpenSymbols?.delete(normalizedParsed.symbol);
    }
  }
}