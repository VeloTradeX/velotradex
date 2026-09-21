/**
 * AI 日志「重新解析」重试逻辑。
 * 抽自 AIConfig.vue，使用模块级共享状态保证表格行内按钮与详情弹窗内的
 * 重试按钮能共用同一份「正在重试」状态，避免出现两个不一致的 loading。
 */
import { ref } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'

/** 模块级共享：当前正在重试的日志 ID 列表。 */
const retryingLogIds = ref<number[]>([])

/** 判断指定日志是否正在重试中。 */
export const isRetrying = (logId?: number): boolean => {
  if (!logId) return false
  return retryingLogIds.value.includes(logId)
}

/**
 * 创建一个重试控制器。
 * @param refresh 重试成功后用于刷新日志列表的回调（通常是父组件的 fetchLogs）。
 */
export function useAiLogRetry(refresh: () => Promise<void>) {
  const retryLog = async (log: any, triggerOrder = false): Promise<any | null> => {
    if (!log?.id || isRetrying(log.id)) return null

    retryingLogIds.value = [...retryingLogIds.value, log.id]
    try {
      const res = await request.post(`/ai-config/logs/${log.id}/retry`, { triggerOrder })
      if (res.data.warning) {
        ElMessage.warning(res.data.warning)
      }
      if (res.data.orderResult) {
        ElMessage.success(`订单已触发: ${res.data.orderResult.symbol} ${res.data.orderResult.side}`)
      } else {
        ElMessage.success('已重新解析')
      }
      await refresh()
      return res.data
    } catch {
      // 全局拦截器已统一提示错误
      return null
    } finally {
      retryingLogIds.value = retryingLogIds.value.filter((id) => id !== log.id)
    }
  }

  return { isRetrying, retryLog }
}
