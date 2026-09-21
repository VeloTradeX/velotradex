import { ref } from 'vue'
import request from '../utils/request'
import type { StrategyDetailResponse } from '../types/strategy'

export function useStrategyDetail() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const data = ref<StrategyDetailResponse | null>(null)

  async function fetchDetail(strategyId: number) {
    loading.value = true
    error.value = null
    try {
      const res = await request.get(`/strategies/${strategyId}/details`)
      data.value = res.data
    } catch (err: any) {
      error.value = err.message || 'Failed to fetch strategy details'
    } finally {
      loading.value = false
    }
  }

  function reset() {
    data.value = null
    error.value = null
    loading.value = false
  }

  return { loading, error, data, fetchDetail, reset }
}
