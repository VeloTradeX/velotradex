import { Op } from 'sequelize';

/**
 * 统一的"虚拟交易所"类型集合。
 * 新增虚拟交易所类型（如 virtual_gate_tradfi）时，只需在此登记，
 * 各虚拟专用接口 / 全局排除逻辑 / 健康探测即可自动识别。
 */
export const VIRTUAL_EXCHANGE_TYPES = ['virtual_gate', 'virtual_gate_tradfi'] as const;

export type VirtualExchangeType = (typeof VIRTUAL_EXCHANGE_TYPES)[number];

/** Sequelize where 片段：type IN （虚拟交易所类型） */
export const VIRTUAL_TYPE_OP = { [Op.in]: [...VIRTUAL_EXCHANGE_TYPES] } as const;

/** 判断是否属于虚拟交易所类型 */
export function isVirtualExchangeType(type?: string | null): boolean {
  return !!type && (VIRTUAL_EXCHANGE_TYPES as readonly string[]).includes(type);
}