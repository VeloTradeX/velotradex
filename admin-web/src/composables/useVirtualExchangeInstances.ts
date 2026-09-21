import { ref } from 'vue'
import request from '../utils/request'

export interface VirtualExchangeInstance {
  id: string
  type: string
  name: string
  status: string
}

export const useVirtualExchangeInstances = () => {
  const exchanges = ref<VirtualExchangeInstance[]>([])
  const loading = ref(false)

  const fetchExchanges = async () => {
    loading.value = true
    try {
      const res = await request.get('/virtual-exchange/instances')
      exchanges.value = res.data
    } finally {
      loading.value = false
    }
  }

  const formatExchangeLabel = (exchange: VirtualExchangeInstance) => {
    return `${exchange.name || exchange.id} (${exchange.id})`
  }

  return {
    exchanges,
    loading,
    fetchExchanges,
    formatExchangeLabel,
  }
}
