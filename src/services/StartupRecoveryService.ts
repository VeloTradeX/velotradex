import { Op } from 'sequelize';
import { Order, Strategy } from '../models';
import parserConfigService from './ParserConfigService';
import strategyParserRegistry from './parsers';
import exchangeRegistry from './exchanges';
import auditService from './AuditService';
import logger, { formatError } from '../utils/logger';
import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';
import { IExchange, OrderResult } from './exchanges/IExchange';
import { NoStopLossMonitor } from './NoStopLossMonitor';
import { ProtectionPipeline } from './ProtectionPipeline';
import { PostFillOrchestrator } from './PostFillOrchestrator';
import type { CloseExecutor } from './executor/types';

/**
 * Minimal collaboration facade exposing the parts of TradeExecutor that the
 * startup/recovery orchestration relies on, so that the recovery logic can be
 * extracted without coupling StartupRecoveryService to the full TradeExecutor.
 */
export interface ExecutorRecoveryFacade extends CloseExecutor {
  getProtectionPipeline(exchangeInstanceId?: string): ProtectionPipeline;
  createPostFillOrchestrator(exchange: any, noStopLossMonitor: NoStopLossMonitor, tradeExecutor: CloseExecutor): PostFillOrchestrator;
  getFillWaitTimeout(exchange?: unknown): number | undefined;
  runWithStrategyTrace<T>(strategyId: number | undefined, fn: () => Promise<T>): Promise<T>;
  noStopLossMonitor: NoStopLossMonitor;
}

export class StartupRecoveryService {
  constructor(private readonly executor: ExecutorRecoveryFacade) {}

  public async recoverMonitors() {
      try {
          const pendingOrders = await Order.findAll({
              where: { status: 'open', isSimulated: false, backtestRunId: { [Op.is]: null } }
          });

          if (pendingOrders.length === 0) {
              logger.info('TradeExecutor: No pending orders to recover.');
              return;
          }

          logger.info(`TradeExecutor: Found ${pendingOrders.length} pending orders. Checking status...`);

          for (const order of pendingOrders) {
              let exchange: IExchange;
              try {
                  exchange = exchangeRegistry.getExchange(order.exchangeInstanceId);
              } catch (exchangeErr: any) {
                  // 实例可能已删除/停用（DB 中残留 open 订单），单个脏数据
                  // 不得中断整个恢复循环，跳过并告警，等待人工处理。
                  logger.warn(
                      `Exchange instance ${order.exchangeInstanceId} not found for order ${order.id}, skipping recovery.`,
                      formatError(exchangeErr, { orderId: order.id }),
                  );
                  continue;
              }
              try {
                  const strategy = await Strategy.findByPk(order.strategyId);
                  if (!strategy) {
                      logger.warn(`Strategy not found for order ${order.id}, skipping recovery.`);
                      continue;
                  }

                  const parsed: ParsedStrategy = {
                      action: strategy.action as any,
                      symbol: strategy.symbol,
                      side: strategy.side as 'buy' | 'sell',
                      entryPrice: strategy.entryPrice,
                      targets: JSON.parse(strategy.targets || '[]'),
                      stopLoss: strategy.stopLoss,
                      leverage: strategy.leverage || '20',
                      raw: strategy.rawMessage ? JSON.parse(strategy.rawMessage) : {}
                  };

                  let riskConfig: StrategyRiskConfig = {
                      riskMode: 'percentage',
                      riskValue: 5,
                      defaultLeverage: '5',
                      priceTolerance: 0.01
                  };

                  if (strategy.parserName) {
                      const parser = strategyParserRegistry.getParserByName(strategy.parserName);
                      if (parser) {
                          const defaultConfig = parser.getRiskConfig();
                          riskConfig = await parserConfigService.getEffectiveConfig(strategy.parserName, defaultConfig);
                      }
                  }

                  let orderInfo: OrderResult;
                  try {
                      orderInfo = await exchange.getOrder(order.exchangeOrderId, order.symbol);
                  } catch (e: any) {
                      logger.warn(`Failed to fetch order info for ${order.exchangeOrderId} during recovery. Assuming it might be filled/cancelled?`, { error: e });

                      if (e.responseBody?.label === 'ORDER_NOT_FOUND' || e.response?.status === 404 || (e.message && e.message.includes('404'))) {
                          logger.info(`Order ${order.exchangeOrderId} not found (404). Marking as CANCELLED/CLOSED in DB to stop recovery.`);
                          const prevStatus = order.lifecycleStatus;
                          order.status = 'cancelled';
                          order.lifecycleStatus = 'CLOSED';
                          await order.save();
                          logger.info('Order lifecycle status changed', {
                            orderId: order.id,
                            exchangeOrderId: order.exchangeOrderId,
                            fromStatus: prevStatus,
                            toStatus: 'CLOSED',
                            reason: 'order not found on exchange (404)',
                          });
                          if (strategy) await auditService.log(strategy.id, 'ORDER_NOT_FOUND_RECOVERY', { orderId: order.id, note: 'Marked as closed due to 404' });
                      }

                      continue;
                  }

                  if (orderInfo.status === 'filled' || orderInfo.status === 'finished') {
                       logger.info(`Order ${order.exchangeOrderId} is FILLED (was 'open' in DB). Executing Post-Fill...`);

                       const prevStatus = order.lifecycleStatus;
                       order.status = 'filled';
                       order.lifecycleStatus = 'OPEN';
                       await order.save();
                       logger.info('Order lifecycle status changed', {
                         orderId: order.id,
                         exchangeOrderId: order.exchangeOrderId,
                         fromStatus: prevStatus,
                         toStatus: 'OPEN',
                         reason: 'recovered from exchange state',
                       });
                       await auditService.log(strategy.id, 'ORDER_FILLED_RECOVERY', { orderId: order.id }, undefined, 'OPEN');

                       const orchestrator = this.executor.createPostFillOrchestrator(exchange, this.executor.noStopLossMonitor, this.executor);
                       await orchestrator.run({
                           order,
                           parsed,
                           riskConfig,
                           source: strategy.source,
                           strategyId: strategy.id,
                           exchangeInstanceId: order.exchangeInstanceId,
                           // 恢复感知：入场单若已通过 tpsl 自带保护，post-fill 不得重复挂单。
                           ...tpslAttachFlags(orderInfo),
                       });

                  } else if (orderInfo.status === 'cancelled') {
                       logger.info(`Order ${order.exchangeOrderId} is CANCELLED (was 'open' in DB). Updating DB.`);
                       const prevStatus = order.lifecycleStatus;
                       order.status = 'cancelled';
                       order.lifecycleStatus = 'CLOSED';
                       await order.save();
                       logger.info('Order lifecycle status changed', {
                         orderId: order.id,
                         exchangeOrderId: order.exchangeOrderId,
                         fromStatus: prevStatus,
                         toStatus: 'CLOSED',
                         reason: 'recovered from exchange state',
                       });
                  } else {
                       logger.info(`Order ${order.exchangeOrderId} is still OPEN. Re-attaching monitor...`);

                       // P0-1: 恢复时的订单必然还挂在交易所（status='open'）。
                       // 限价/未知类型挂单可能长时间不成交，使用无限等待（timeoutMs=0），
                       // 避免 60s 后监听完结、订单成为无人照看的 PENDING。
                       const fillWaitTimeout = order.type === 'market' ? this.executor.getFillWaitTimeout(exchange) : 0;
                       exchange.waitForOrderFill(order.exchangeOrderId, order.symbol, fillWaitTimeout)
                        .then(async (filledOrder: OrderResult) => {
                             await this.executor.runWithStrategyTrace(strategy.id, async () => {
                                 logger.info(`Order ${filledOrder.id} filled (WS-Recovered)! Executing Post-Fill Logic...`);

                                 const prevStatus = order.lifecycleStatus;
                                 order.status = 'filled';
                                 order.lifecycleStatus = 'OPEN';
                                 await order.save();
                                 logger.info('Order lifecycle status changed', {
                                   orderId: order.id,
                                   exchangeOrderId: order.exchangeOrderId,
                                   fromStatus: prevStatus,
                                   toStatus: 'OPEN',
                                   reason: 'recovered from exchange state',
                                 });
                                 await auditService.log(strategy.id, 'ORDER_FILLED_WS', { orderId: order.id }, undefined, 'OPEN');

                                 const orchestrator = this.executor.createPostFillOrchestrator(exchange, this.executor.noStopLossMonitor, this.executor);
                                 await orchestrator.run({
                                     order,
                                     parsed,
                                     riskConfig,
                                     source: strategy.source,
                                     strategyId: strategy.id,
                                     exchangeInstanceId: order.exchangeInstanceId,
                                     ...tpslAttachFlags(orderInfo),
                                 });
                             });
                        })
                        .catch(async (err: any) => {
                            await this.executor.runWithStrategyTrace(strategy.id, async () => {
                                logger.warn(`Order ${order.exchangeOrderId} monitor ended/timed out`, formatError(err));
                            });
                        });
                  }
              } catch (err: any) {
                  logger.error(`Failed to recover order ${order.id}`, formatError(err));
              }
          }

      } catch (error: any) {
          logger.error('Failed to recover monitors', formatError(error));
      }
  }

  public async recoverPositions() {
      try {
          const exchanges = exchangeRegistry.getAllExchanges();
          logger.info(`TradeExecutor: Recovering positions for ${exchanges.length} exchanges...`);

          for (const exchange of exchanges) {
              try {
                  const positions = await exchange.getPositions();

                  if (positions.length > 0) {
                      logger.info(`TradeExecutor: Found ${positions.length} active positions on ${exchange.name}.`);
                  }
              } catch (exErr: any) {
                  logger.warn(`Failed to recover positions for exchange ${exchange.name}`, formatError(exErr));
              }
          }
      } catch (error: any) {
          logger.error('Failed to recover/check positions', formatError(error));
      }
  }

  public async reconcilePendingOrders(exchangeInstanceId: string, exchange: any, reason: string): Promise<void> {
      const pendingOrders = await Order.findAll({
          where: {
              exchangeInstanceId,
              status: 'open',
              lifecycleStatus: 'PENDING',
              isSimulated: false,
          },
      });

      if (pendingOrders.length === 0) {
          logger.info(`TradeExecutor: ${reason} reconcile found no pending orders for ${exchangeInstanceId}.`);
          return;
      }

      logger.info(`TradeExecutor: ${reason} reconcile checking ${pendingOrders.length} pending orders for ${exchangeInstanceId}.`);

      for (const order of pendingOrders) {
          await this.reconcilePendingOrder(order, exchange, reason);
      }
  }

  private async reconcilePendingOrder(order: Order, exchange: any, reason: string): Promise<void> {
      try {
          const strategy = await Strategy.findByPk(order.strategyId);
          if (!strategy) {
              logger.warn(`Strategy not found for pending order ${order.id}, skipping ${reason} reconcile.`);
              return;
          }

          const parsed: ParsedStrategy = {
              action: strategy.action as any,
              symbol: strategy.symbol,
              side: strategy.side as 'buy' | 'sell',
              entryPrice: strategy.entryPrice,
              targets: JSON.parse(strategy.targets || '[]'),
              stopLoss: strategy.stopLoss,
              leverage: strategy.leverage || '20',
              raw: strategy.rawMessage ? JSON.parse(strategy.rawMessage) : {},
          };

          let riskConfig: StrategyRiskConfig = {
              riskMode: 'percentage',
              riskValue: 5,
              defaultLeverage: '5',
              priceTolerance: 0.01,
          };

          if (strategy.parserName) {
              const parser = strategyParserRegistry.getParserByName(strategy.parserName);
              if (parser) {
                  const defaultConfig = parser.getRiskConfig();
                  riskConfig = await parserConfigService.getEffectiveConfig(strategy.parserName, defaultConfig);
              }
          }

          const orderInfo = await exchange.getOrder(order.exchangeOrderId, order.symbol);
          if (orderInfo.status === 'filled' || orderInfo.status === 'finished') {
              logger.info(`Order ${order.exchangeOrderId} is FILLED during  reconcile. Executing Post-Fill...`);

              order.status = 'filled';
              order.lifecycleStatus = 'OPEN';
              order.filledAmount = orderInfo.amount ?? order.filledAmount;
              order.filledPrice = orderInfo.price ?? order.filledPrice;
              await order.save();
              await auditService.log(strategy.id, 'ORDER_FILLED_RECONNECT_REST', { orderId: order.id }, undefined, 'OPEN');

              const orchestrator = this.executor.createPostFillOrchestrator(exchange, this.executor.noStopLossMonitor, this.executor);
              await orchestrator.run({
                  order,
                  parsed,
                  riskConfig,
                  source: strategy.source,
                  strategyId: strategy.id,
                  exchangeInstanceId: order.exchangeInstanceId,
                  ...tpslAttachFlags(orderInfo),
              });
              return;
          }

          if (orderInfo.status === 'cancelled') {
              logger.info(`Order ${order.exchangeOrderId} is CANCELLED during  reconcile. Updating DB.`);
              order.status = 'cancelled';
              order.lifecycleStatus = 'CLOSED';
              await order.save();
              return;
          }

          logger.info(`Order ${order.exchangeOrderId} remains ${orderInfo.status} during  reconcile.`);
      } catch (err: any) {
          logger.warn(`Failed to reconcile pending order ${order.id} after ${reason}`, formatError(err));
      }
  }
}

/**
 * 从交易所订单查询结果（OrderResult.raw）提取入场单自带 TP/SL 标记。
 *
 * 恢复/对账路径据此告诉 PostFillOrchestrator：该入场单已通过
 * tpsl_tp_trigger_price / tpsl_sl_trigger_price 自带保护，post-fill 不得
 * 重复挂 SL/TP。raw 可能是 SDK 反序列化结果（camelCase）或原始 API 响应
 * （snake_case），两种都兼容。
 */
function tpslAttachFlags(orderInfo: OrderResult): { slPreAttached: boolean; tpPreAttached: boolean } {
    const raw: any = orderInfo?.raw && typeof orderInfo.raw === 'object' ? orderInfo.raw : {};
    const sl = raw.tpslSlTriggerPrice ?? raw.tpsl_sl_trigger_price;
    const tp = raw.tpslTpTriggerPrice ?? raw.tpsl_tp_trigger_price;
    return {
        slPreAttached: !!sl,
        tpPreAttached: !!tp,
    };
}