<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-select
            v-model="filterExchange"
            placeholder="虚拟交易所实例"
            style="width: 220px;"
            clearable
            filterable
            @change="fetchOrders"
            @clear="fetchOrders"
          >
            <el-option
              v-for="ex in exchanges"
              :key="ex.id"
              :label="formatExchangeLabel(ex)"
              :value="ex.id"
            >
              <div class="option-with-logo">
                <ExchangeLogo :type="ex.type" size="sm" />
                <span class="name-text">{{ formatExchangeLabel(ex) }}</span>
              </div>
            </el-option>
          </el-select>

          <el-input v-model="filterSymbol" placeholder="交易对" style="width: 160px;" clearable @clear="fetchOrders" />
          <el-input v-model="filterSource" placeholder="策略来源" style="width: 160px;" clearable @clear="fetchOrders" />
          <el-select
            v-model="filterParser"
            placeholder="解析器"
            style="width: 180px;"
            clearable
            filterable
            @change="fetchOrders"
            @clear="fetchOrders"
          >
            <el-option
              v-for="parser in parserOptions"
              :key="parser.name"
              :label="parser.name"
              :value="parser.name"
            />
          </el-select>
          <el-button type="primary" :icon="Search" @click="fetchOrders">搜索</el-button>
          <el-button :icon="Refresh" @click="fetchOrders">刷新</el-button>
        </div>
      </div>
    </el-card>

    <div class="content-area">
      <el-table
        ref="ordersTable"
        :data="orders"
        style="width: 100%"
        v-loading="loading"
        @expand-change="handleExpandChange"
        @row-click="handleRowClick"
        class="data-table"
        empty-text="暂无虚拟交易所订单"
      >
        <el-table-column type="expand">
          <template #default="props">
            <div class="audit-panel">
              <el-skeleton :rows="3" animated v-if="loadingMap[props.row.id]" />
              <div v-else-if="auditLogsMap[props.row.id]?.length">
                <el-timeline>
                  <el-timeline-item
                    v-for="(log, index) in auditLogsMap[props.row.id]"
                    :key="index"
                    :timestamp="formatDate(log.createdAt)"
                    :type="getTimelineType(log.action)"
                    placement="top"
                  >
                    <el-card shadow="never">
                      <h4>{{ formatAction(log.action) }}</h4>
                      <pre class="json-details">{{ formatDetails(log.details) }}</pre>
                    </el-card>
                  </el-timeline-item>
                </el-timeline>
              </div>
              <el-empty v-else description="暂无追踪记录" />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="时间" width="180">
          <template #default="scope">{{ formatDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="symbol" label="交易对" min-width="120" />
        <el-table-column label="解析器" width="150">
          <template #default="scope">{{ scope.row.Strategy?.parserName || '-' }}</template>
        </el-table-column>
        <el-table-column label="交易所" width="200">
          <template #default="scope">
            <div class="cell-with-logo">
              <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
              <span>{{ scope.row.exchangeInstanceId || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="130">
          <template #default="scope">
            <StatusBadge :value="scope.row.status" kind="status" />
          </template>
        </el-table-column>
        <el-table-column label="盈亏" min-width="150" sortable :sort-method="(a: any, b: any) => Number(a.pnlAmount || 0) - Number(b.pnlAmount || 0)" header-align="center" header-class-name="pnl-header">
          <template #default="scope">
            <el-tooltip
              v-if="scope.row.pnlPercent != null && scope.row.pnlPercent !== 0"
              :content="formatPnlPercent(scope.row.pnlPercent)"
              placement="top"
            >
              <span :class="['pnl-text', getPnlClass(scope.row.pnlAmount)]">{{ formatPnl(scope.row.pnlAmount) }}</span>
            </el-tooltip>
            <span v-else :class="['pnl-text', getPnlClass(scope.row.pnlAmount)]">{{ formatPnl(scope.row.pnlAmount) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="side" label="方向" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.side" kind="side" />
          </template>
        </el-table-column>
                <el-table-column label="成交价格" width=" 120">
          <template #default="scope">{{ formatPrice(scope.row.filledPrice) }}</template>
        </el-table-column>
        <el-table-column label="平仓价格" width="120">
          <template #default="scope">{{ formatPrice(scope.row.closePrice || scope.row.exitPrice) }}</template>
        </el-table-column>
        <el-table-column label="最新价格" width="120">
          <template #default="scope">{{ formatPrice(scope.row.lastPrice) }}</template>
        </el-table-column>
        <el-table-column label="数量" width="130">
          <template #default="scope">{{ formatBaseAmount(scope.row) }}</template>
        </el-table-column>
        <el-table-column prop="strategyId" label="策略 ID" width="110" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="scope">
            <el-button
              v-if="canCancelOrder(scope.row)"
              type="danger"
              size="small"
              :icon="Delete"
              :loading="cancelLoadingMap[scope.row.id]"
              @click.stop="cancelOrder(scope.row)"
            />
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Refresh, Search } from '@element-plus/icons-vue'
import request from '../utils/request'
import { useVirtualExchangeInstances } from '../composables/useVirtualExchangeInstances'
import { formatPrice, formatBaseAmount, formatDetails, formatDate } from '../utils/format'
import { formatAction, getTimelineType } from '../utils/auditFormatters'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

const { exchanges, fetchExchanges, formatExchangeLabel } = useVirtualExchangeInstances()

const orders = ref<any[]>([])
const loading = ref(false)
const ordersTable = ref()
const auditLogsMap = ref<Record<string, any[]>>({})
const loadingMap = ref<Record<string, boolean>>({})
const cancelLoadingMap = ref<Record<string, boolean>>({})
const parserOptions = ref<any[]>([])

const filterExchange = ref('')
const filterSymbol = ref('')
const filterSource = ref('')
const filterParser = ref('')

const formatPnl = (val: string | number | null | undefined) => {
  if (val === null || val === undefined || val === '') return '-'
  const num = Number(val)
  if (Number.isNaN(num)) return '-'
  const prefix = num > 0 ? '+' : ''
  return `${prefix}${num.toFixed(2)} USDT`
}

const formatPnlPercent = (val: number | null | undefined) => {
  if (val === null || val === undefined) return '-'
  if (Number.isNaN(val)) return '-'
  const prefix = val > 0 ? '+' : ''
  return `${prefix}${val.toFixed(2)}%`
}

const getPnlClass = (val: string | number | null | undefined) => {
  if (val === null || val === undefined || val === '') return 'neutral'
  const num = Number(val)
  if (Number.isNaN(num) || num === 0) return 'neutral'
  return num > 0 ? 'profit' : 'loss'
}

const canCancelOrder = (row: any) => String(row.status || '').toLowerCase() === 'open'

const cancelOrder = async (row: any) => {
  try {
    await ElMessageBox.confirm(`确认取消 ${row.symbol} 的虚拟订单 ${row.exchangeOrderId || row.id}？`, '取消订单', {
      confirmButtonText: '确认取消',
      cancelButtonText: '返回',
      type: 'warning',
    })
  } catch {
    return
  }

  cancelLoadingMap.value[row.id] = true
  try {
    await request.post(`/virtual-exchange/orders/${row.id}/cancel`)
    ElMessage.success('订单已取消')
    await fetchOrders()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '取消虚拟订单失败')
  } finally {
    cancelLoadingMap.value[row.id] = false
  }
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

const fetchOrders = async () => {
  loading.value = true
  try {
    const params: any = { limit: 100 }
    if (filterExchange.value) params.exchangeInstanceId = filterExchange.value
    if (filterSymbol.value) params.symbol = filterSymbol.value
    if (filterSource.value) params.source = filterSource.value
    if (filterParser.value) params.parser = filterParser.value

    const res = await request.get('/virtual-exchange/orders', { params })
    orders.value = res.data
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '获取虚拟交易所订单失败')
  } finally {
    loading.value = false
  }
}

const fetchParsers = async () => {
  try {
    const res = await request.get('/parsers')
    parserOptions.value = res.data
  } catch {
    ElMessage.error('获取 Parser 列表失败')
  }
}

const handleRowClick = (row: any) => {
  if (!ordersTable.value) return
  orders.value.forEach((item: any) => {
    if (item.id !== row.id) ordersTable.value.toggleRowExpansion(item, false)
  })
  ordersTable.value.toggleRowExpansion(row)
}

const handleExpandChange = async (row: any, expandedRows: any[]) => {
  const isExpanded = expandedRows.some(r => r.id === row.id)
  if (!isExpanded || auditLogsMap.value[row.id]) return

  loadingMap.value[row.id] = true
  try {
    const res = await request.get(`/orders/${row.id}/audit`)
    auditLogsMap.value[row.id] = res.data
  } catch {
    ElMessage.error('获取追踪记录失败')
  } finally {
    loadingMap.value[row.id] = false
  }
}

onMounted(async () => {
  await fetchExchanges()
  await fetchParsers()
  await fetchOrders()
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

.filter-header,
.left-panel {
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

.audit-panel {
  padding: 20px;
}

.json-details {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

.pnl-text.profit {
  color: #67c23a;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.pnl-text.loss {
  color: #f56c6c;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.pnl-text.neutral {
  color: #909399;
  font-variant-numeric: tabular-nums;
}

/* P&L column header highlight */
:deep(.el-table th.pnl-header) {
  background-color: #ecf5ff !important;
}

</style>
