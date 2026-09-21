import { Op } from 'sequelize';
import { ExchangeInstance, Order, Strategy } from '../models';
import { VIRTUAL_TYPE_OP } from '../utils/virtualTypes';

export type OrderTimeField = 'createdAt' | 'updatedAt' | 'closedAt';

export interface FormalOrderQuery {
  limit?: string | number;
  symbol?: string;
  exchange?: string;
  source?: string;
  parser?: string;
  startDate?: string;
  endDate?: string;
  timeField?: string;
  /** 回测数据隔离：数字=指定回测；'all'=全部；缺省=仅实盘 */
  backtestRunId?: string;
}

function parseDateQuery(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function applyDateRange(where: any, query: Pick<FormalOrderQuery, 'startDate' | 'endDate'>, field = 'createdAt') {
  const startDate = parseDateQuery(query.startDate);
  const endDate = parseDateQuery(query.endDate);
  if (startDate && endDate) {
    where[field] = { [Op.between]: [startDate, endDate] };
  } else if (startDate) {
    where[field] = { [Op.gte]: startDate };
  } else if (endDate) {
    where[field] = { [Op.lte]: endDate };
  }
}

export function resolveOrderTimeField(value: unknown): OrderTimeField {
  return value === 'updatedAt' || value === 'closedAt' ? value : 'createdAt';
}

function parseLimit(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function getVirtualExchangeIds(): Promise<string[]> {
  const virtualExchanges = await ExchangeInstance.findAll({
    where: { type: VIRTUAL_TYPE_OP },
    attributes: ['id'],
    raw: true,
  }) as Array<{ id: string }>;

  return virtualExchanges.map(exchange => exchange.id);
}

export async function buildFormalOrderWhere(query: FormalOrderQuery) {
  const where: any = {};
  const virtualExchangeIds = await getVirtualExchangeIds();

  if (query.symbol) where.symbol = query.symbol;
  if (query.source) where.source = query.source;

  // 回测数据隔离：默认排除回测订单；指定 backtestRunId 时只看该回测；
  // backtestRunId=all 时不过滤。回测订单的交易所实例（bt_）本身也是虚拟类型，
  // 但查询指定回测时需要看到它们，故此过滤放在虚拟排除逻辑之前独立处理。
  if (query.backtestRunId === 'all') {
    // 不过滤
  } else if (query.backtestRunId && Number.isFinite(Number(query.backtestRunId))) {
    where.backtestRunId = Number(query.backtestRunId);
    applyDateRange(where, query, resolveOrderTimeField(query.timeField));
    return where;
  } else {
    where.backtestRunId = { [Op.is]: null };
  }

  if (query.exchange) {
    if (virtualExchangeIds.includes(query.exchange)) {
      where.id = { [Op.eq]: -1 };
    } else {
      where.exchangeInstanceId = query.exchange;
    }
  } else if (virtualExchangeIds.length > 0) {
    where[Op.or] = [
      { exchangeInstanceId: { [Op.notIn]: virtualExchangeIds } },
      { exchangeInstanceId: { [Op.is]: null } },
    ];
  }

  applyDateRange(where, query, resolveOrderTimeField(query.timeField));
  return where;
}

export async function listFormalOrders(query: FormalOrderQuery, fallbackLimit = 50) {
  const where = await buildFormalOrderWhere(query);
  const include: any[] = [{ model: Strategy, as: 'Strategy' }];

  if (query.parser) {
    include[0].where = { parserName: query.parser };
  }

  return Order.findAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: parseLimit(query.limit, fallbackLimit),
    include,
  });
}
