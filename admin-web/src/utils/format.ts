/**
 * 通用格式化工具
 *
 * 集中存放多个视图中重复出现、且行为一致的纯函数，避免在各 `.vue` 文件中散落
 * 多份相同或近似的实现。所有函数均为无副作用的纯函数，输入相同则输出相同，
 * 因此替换原有副本不会改变任何视觉与交互效果。
 */

import dayjs from 'dayjs'

/**
 * 格式化价格（默认保留最多 4 位小数）。
 *
 * - 空值（`null` / `undefined` / 空字符串）返回占位符 `'-'`
 * - 非数字原样返回
 * - 小数位数超过 `maxDecimals` 时截断到 `maxDecimals` 位，否则保留原始精度
 *
 * 适用于大多数交易价格展示（Orders、Positions、VirtualExchangeOrders 等）。
 */
export function formatPrice(value: string | number, maxDecimals = 4): string | number {
  if (value === null || value === undefined || value === '') return '-'
  const num = Number(value)
  if (Number.isNaN(num)) return value

  const str = value.toString()
  if (str.includes('.')) {
    const decimal = str.split('.')[1]
    if (decimal && decimal.length > maxDecimals) {
      return num.toFixed(maxDecimals)
    }
  }
  return value
}

/**
 * 格式化固定小数位数值（默认 2 位）。与 `formatPrice` 不同，本函数始终按
 * `decimals` 位输出，常用于金额/余额展示。
 *
 * - 空值返回 `'-'`
 * - 非数字原样返回
 */
export function formatFixed(value: string | number | null | undefined, decimals = 2): string | number {
  if (value === null || value === undefined || value === '') return '-'
  const num = Number(value)
  if (Number.isNaN(num)) return value
  return num.toFixed(decimals)
}

/**
 * 格式化虚拟交易所订单/成交的「基础资产数量」。
 *
 * 优先展示 `baseAmount` + `baseCurrency`；缺失时回退到 `amount`。
 */
export function formatBaseAmount(row: {
  baseAmount?: string | null
  baseCurrency?: string | null
  amount?: string | null
}): string {
  if (row.baseAmount !== null && row.baseAmount !== undefined && row.baseAmount !== '') {
    return `${row.baseAmount} ${row.baseCurrency || ''}`.trim()
  }
  return row.amount || '-'
}

/**
 * 将买卖方向映射为 Element Plus `el-tag` 的类型，保证全站视觉一致。
 */
export function sideTagType(side: string): 'success' | 'danger' | 'info' {
  if (side === 'buy') return 'success'
  if (side === 'sell') return 'danger'
  return 'info'
}

/**
 * 将可能为空的字段格式化为占位符 `'-'`。
 */
export function formatNullable(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '-' : String(value)
}

/**
 * 将审计/订单详情格式化为可读的 JSON 字符串；解析失败时原样返回。
 */
export function formatDetails(details: string | object): string | object {
  try {
    if (typeof details === 'string') {
      return JSON.stringify(JSON.parse(details), null, 2)
    }
    return JSON.stringify(details, null, 2)
  } catch {
    return details
  }
}

/**
 * 统一日期时间格式化（全站唯一来源）。
 *
 * 将任意可解析的日期值格式化为时间字符串（本地时区）；若该时间属于今年，
 * 只显示 `MM-DD HH:mm:ss` 以方便查看，超出今年才显示完整 `YYYY-MM-DD HH:mm:ss`。
 * 空值（`null` / `undefined` / 空字符串）或无法解析的值返回占位符 `'-'`。
 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  const d = dayjs(value)
  if (!d.isValid()) return '-'
  return d.year() === dayjs().year() ? d.format('MM-DD HH:mm:ss') : d.format('YYYY-MM-DD HH:mm:ss')
}

/** 去掉末尾多余的 0，并避免浮点精度问题；非有限数原样返回。 */
function trimNumber(value: number): string {
  return parseFloat(value.toFixed(10)).toString()
}

/**
 * 将 Token 总数格式化为便于阅读的形式：达到千位即转成 `K`，最多保留 2 位小数。
 * 例如 1234 -> `1.23K`、980000 -> `980K`、999 -> `999`。
 */
export function formatTokenCount(total: string | number | null | undefined): string {
  if (total === null || total === undefined || total === '') return '-'
  const num = Number(total)
  if (Number.isNaN(num)) return String(total)
  if (num >= 1000) {
    return `${trimNumber(num / 1000)}K`
  }
  return String(num)
}

/**
 * 将耗时（毫秒）格式化为秒，最多保留 2 位小数。例如 5230ms -> `5.23`。
 */
export function formatDurationSec(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '-'
  const num = Number(ms)
  if (Number.isNaN(num)) return String(ms)
  return trimNumber(num / 1000)
}

/**
 * Gate-CFD 品种每手合约数量（与后端 `getVirtualContractMultiplier` 中
 * dict/gate_cfd_symbols.json 的 contractVolume 保持一致）。
 * 系统内 amount 以「手」为单位，金额 = 手数 × 每手合约数量，例如
 * XAU_USDT 0.01 手 = 1 XAU，XAG_USDT 0.01 手 = 50 XAG。
 */
const CFD_CONTRACT_VOLUMES: Record<string, number> = {
  XAU: 100,
  XAG: 5000,
  XBR: 100,
  XTI: 100,
  EUR: 100000,
  AUD: 100000,
  GBP: 100000,
}

/**
 * 根据交易对推导合约乘数（与后端 `getVirtualContractMultiplier` 的兜底逻辑保持一致）。
 * BTC 系 0.0001、ETH 系 0.01；贵金属/能源/外汇等 Gate-CFD 品种按每手合约数量换算；其余按 1 处理。
 */
function contractMultiplier(symbol: string): number {
  if (!symbol) return 1
  const base = String(symbol).toUpperCase().split('_')[0] ?? ''
  if (base === 'BTC') return 0.0001
  if (base === 'ETH') return 0.01
  if (CFD_CONTRACT_VOLUMES[base]) return CFD_CONTRACT_VOLUMES[base]
  return 1
}

/**
 * 将合约数量格式化为标的真实数量，即 `amount * 合约乘数`。
 * 例如 BTC 合约数量 980 -> `0.098`。空值返回 `'-'`。
 */
export function formatContractAmount(symbol: string | null | undefined, amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '-'
  const num = Number(amount)
  if (Number.isNaN(num)) return String(amount)
  return trimNumber(num * contractMultiplier(symbol || ''))
}
