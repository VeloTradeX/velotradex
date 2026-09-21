/**
 * 日志展示相关纯函数（表格与详情共用），集中维护避免重复定义。
 */

const baseLogFields = new Set(['timestamp', 'level', 'message', 'traceId'])

export const getLevelType = (level: string) => {
  switch (level) {
    case 'error': return 'danger'
    case 'warn': return 'warning'
    case 'info': return 'success'
    default: return 'info'
  }
}

export const getExtraEntries = (log: Record<string, any>) => {
  return Object.entries(log).filter(([key, value]) => {
    if (baseLogFields.has(key)) return false
    return value !== undefined && value !== null && value !== ''
  })
}

export const formatFieldValue = (value: unknown) => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}
