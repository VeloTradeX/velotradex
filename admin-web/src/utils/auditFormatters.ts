// 审计相关的格式化工具。
// 通用、与审计无关的格式化函数（formatPrice、formatDetails 等）已统一收录在
// `./format` 中，此处直接再导出以保持既有引用兼容，避免重复实现。

export { formatPrice, formatDetails } from './format'

// 策略/订单动作的中文映射
export function formatAction(action: string) {
  const map: Record<string, string> = {
    STRATEGY_CREATED: '策略生成',
    EXECUTING: '开始执行',
    SUBMITTING_ORDER: '提交订单',
    SUBMITTING_CLOSE_ORDER: '提交平仓订单',
    ORDER_CREATED: '订单创建成功',
    ORDER_FAILED: '订单创建失败',
    ORDER_PLACEMENT_FAILED: '下单失败',
    CLOSE_ORDER_FAILED: '平仓失败',
    ORDER_UPDATE_WS: '订单状态更新',
    PLACING_PROTECTION: '设置止盈止损',
    PROTECTION_RETRY_FOUND: '保护机制重试成功',
    CANCELLING_ORDER: '取消订单'
  }
  return map[action] || action
}

// 根据动作类型返回时间线节点的展示类型
export function getTimelineType(action: string) {
  if (action.includes('FAILED')) return 'danger'
  if (action.includes('CREATED') || action.includes('FILLED')) return 'success'
  if (action.includes('SUBMITTING') || action.includes('EXECUTING')) return 'primary'
  return 'info'
}
