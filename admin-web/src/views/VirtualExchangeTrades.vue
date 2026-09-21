<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <el-select v-model="filterExchange" placeholder="虚拟交易所实例" style="width: 220px;" clearable filterable @change="fetchTrades" @clear="fetchTrades">
          <el-option
              v-for="ex in exchanges"
              :key="ex.id"
              :label="formatExchangeLabel(ex)"
              :value="ex.id"
            >
              <div class="option-with-logo">
                <ExchangeLogo :type="ex.type" size="sm" />
                <span class="name-text">{{ ex.name }}</span>
              </div>
            </el-option>
        </el-select>
        <el-input v-model="filterSymbol" placeholder="交易对" style="width: 160px;" clearable @clear="fetchTrades" />
        <el-button type="primary" :icon="Search" @click="fetchTrades">搜索</el-button>
        <el-button :icon="Refresh" @click="fetchTrades">刷新</el-button>
      </div>
    </el-card>

    <div class="content-area">
      <el-table :data="trades" style="width: 100%" v-loading="loading" empty-text="暂无虚拟成交记录">
        <el-table-column prop="executedAt" label="执行时间" width="180">
          <template #default="scope">{{ formatDate(scope.row.executedAt) }}</template>
        </el-table-column>
        <el-table-column label="交易所" width="200">
          <template #default="scope">
            <div class="cell-with-logo">
              <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
              <span>{{ scope.row.exchangeInstanceId || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="symbol" label="交易对" width="130" />
        <el-table-column prop="side" label="方向" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.side" kind="side" />
          </template>
        </el-table-column>
        <el-table-column prop="price" label="价格" width="120" />
        <el-table-column label="数量" width="130">
          <template #default="scope">{{ formatBaseAmount(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="已实现盈亏" width="130">
          <template #default="scope">
            <span :class="pnlClass(scope.row.realizedPnl)">{{ formatPnl(scope.row.realizedPnl) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tradeId" label="成交 ID" min-width="170" />
        <el-table-column prop="virtualOrderId" label="虚拟订单 ID" min-width="180" />
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import request from '../utils/request'
import { useVirtualExchangeInstances } from '../composables/useVirtualExchangeInstances'
import { formatBaseAmount, formatDate } from '../utils/format'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

const { exchanges, fetchExchanges, formatExchangeLabel } = useVirtualExchangeInstances()

const trades = ref<any[]>([])
const loading = ref(false)
const filterExchange = ref('')
const filterSymbol = ref('')

const formatPnl = (value: string | number) => {
  const num = Number(value)
  if (Number.isNaN(num)) return value
  return num.toFixed(4)
}

const pnlClass = (value: string | number) => {
  const num = Number(value)
  if (num > 0) return 'pnl-positive'
  if (num < 0) return 'pnl-negative'
  return ''
}

function resolveExchangeType(row: any) {
  if (!row) return 'virtual_gate'
  const id = row.exchangeInstanceId || row.exchangeId
  if (id) {
    const ex = exchanges.value.find((e: any) => e.id === id)
    if (ex) return ex.type
  }
  return 'virtual_gate'
}

const fetchTrades = async () => {
  loading.value = true
  try {
    const params: any = { limit: 100 }
    if (filterExchange.value) params.exchangeInstanceId = filterExchange.value
    if (filterSymbol.value) params.symbol = filterSymbol.value

    const res = await request.get('/virtual-exchange/trades', { params })
    trades.value = res.data
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '获取虚拟成交记录失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await fetchExchanges()
  await fetchTrades()
})
</script>

<style scoped>
.page-container {
  padding: 0;
}

.filter-card {
  margin-bottom: 16px;
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
}

.filter-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.content-area {
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 20px;
}

.pnl-positive {
  color: #67c23a;
  font-weight: 600;
}

.pnl-negative {
  color: #f56c6c;
  font-weight: 600;
}

</style>
