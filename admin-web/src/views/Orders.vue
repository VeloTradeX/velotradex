<template>
  <div class="page-container">
    <!-- Filter Header Card -->
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-select v-model="filterSymbol" placeholder="交易对 (Symbol)" style="width: 160px;" clearable filterable
            @change="fetchHistoryOrders" @clear="fetchHistoryOrders">
            <el-option v-for="s in symbols" :key="s" :label="s" :value="s" />
          </el-select>

          <el-select v-model="filterExchange" placeholder="交易所 (Exchange)" style="width: 200px;" clearable filterable
            @change="fetchHistoryOrders" @clear="fetchHistoryOrders">
            <el-option v-for="ex in exchanges" :key="ex.id" :label="ex.name || ex.id" :value="ex.id">
              <div class="option-with-logo">
                <ExchangeLogo :type="ex.type" size="sm" />
                <span class="name-text">{{ ex.name || ex.id }}</span>
              </div>
            </el-option>
          </el-select>

          <el-select v-model="filterSource" placeholder="策略来源 (Route)" style="width: 160px;" clearable filterable
            @change="fetchHistoryOrders" @clear="fetchHistoryOrders">
            <el-option v-for="src in sources" :key="src" :label="src" :value="src" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="fetchHistoryOrders">搜索</el-button>
          <el-button :icon="Refresh" @click="fetchHistoryOrders">刷新</el-button>
        </div>

      </div>
    </el-card>

    <!-- Main Content Area -->
    <div class="content-area">
      <el-tabs v-model="activeTab" class="custom-tabs">
        <el-tab-pane label="历史订单" name="history">
          <el-table ref="historyTable" :data="historyOrders" style="width: 100%" v-loading="historyLoading"
            @expand-change="handleExpandChange" @row-click="handleRowClick" class="data-table">
            <el-table-column type="expand">
              <template #default="props">
                <div style="padding: 20px; background-color: #f9f9f9;">
                  <el-skeleton :rows="3" animated v-if="loadingMap[props.row.id]" />
                  <div v-else>
                    <div style="display: flex; align-items: center; margin-bottom: 15px;">
                      <h4 style="margin: 0;">全链路追踪日志</h4>
                      <el-radio-group v-model="viewMode" size="small" @change="handleViewModeChange"
                        style="margin-left: 10px;">
                        <el-radio-button label="overview">概览</el-radio-button>
                        <el-radio-button label="details">详情</el-radio-button>
                      </el-radio-group>
                    </div>

                    <OrderAuditLog
                      v-if="auditLogsMap[props.row.id] && auditLogsMap[props.row.id]!.length > 0"
                      :logs="auditLogsMap[props.row.id]!"
                      :view-mode="viewMode"
                    />
                    <div v-else class="no-logs">
                      暂无追踪记录
                    </div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="时间" width="180">
              <template #default="scope">
                {{ formatDate(scope.row.createdAt) }}
              </template>
            </el-table-column>
            <el-table-column prop="symbol" label="交易对" width="140" show-overflow-tooltip />
            <el-table-column label="解析器" width="150">
              <template #default="scope">
                {{ scope.row.Strategy?.parserName || '-' }}
              </template>
            </el-table-column>
            <el-table-column label="交易所" width="180" show-overflow-tooltip>
              <template #default="scope">
                <div class="cell-with-logo">
                  <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
                  <span>{{ scope.row.exchangeInstanceId || '-' }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="side" label="方向" width="100">
              <template #default="scope">
                <StatusBadge :value="scope.row.side" kind="side" />
              </template>
            </el-table-column>
            <el-table-column prop="price" label="价格">
              <template #default="scope">{{ formatPrice(scope.row.price) }}</template>
            </el-table-column>
            <el-table-column prop="amount" label="数量" width="120">
              <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.amount) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="120">
              <template #default="scope">
                <StatusBadge :value="scope.row.status" kind="status" />
              </template>
            </el-table-column>
            <el-table-column label="盈亏" width="130" align="right">
              <template #default="scope">
                <span
                  v-if="scope.row.realizedPnl != null && scope.row.realizedPnl !== ''"
                  class="pnl-text"
                  :class="pnlClass(scope.row.realizedPnl)"
                >{{ formatPnl(scope.row.realizedPnl) }}</span>
                <span v-else class="pnl-empty">-</span>
              </template>
            </el-table-column>
            <el-table-column label="策略" prop="strategyId" width="80" align="center">
              <template #default="{ row }">
                <a
                  v-if="row.strategyId"
                  class="strategy-link"
                  @click.stop="openStrategyDrawer(row.strategyId, row.id)"
                >{{ row.strategyId }}</a>
                <span v-else style="color: #999">—</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="当前挂单" name="open">
          <div style="margin-bottom: 20px;">
            <el-select v-model="symbol" placeholder="Symbol (e.g. BTC_USDT)" style="width: 200px; margin-right: 10px;"
              filterable allow-create default-first-option>
              <el-option label="BTC_USDT" value="BTC_USDT" />
              <el-option label="ETH_USDT" value="ETH_USDT" />
              <el-option label="SOL_USDT" value="SOL_USDT" />
              <el-option label="DOGE_USDT" value="DOGE_USDT" />
              <el-option label="XRP_USDT" value="XRP_USDT" />
              <el-option label="ORDI_USDT" value="ORDI_USDT" />
              <el-option label="1000SATS_USDT" value="1000SATS_USDT" />
            </el-select>
            <el-button type="primary" :icon="Search" @click="fetchOpenOrders">查询</el-button>
          </div>

          <h3>普通挂单</h3>
          <el-table :data="openOrders" style="width: 100%" empty-text="无挂单">
            <el-table-column prop="id" label="ID" />
          <el-table-column prop="symbol" label="交易对" />
          <el-table-column prop="side" label="方向" width="100">
            <template #default="scope">
              <StatusBadge :value="scope.row.side" kind="side" />
            </template>
          </el-table-column>
          <el-table-column prop="price" label="价格">
            <template #default="scope">{{ formatPrice(scope.row.price) }}</template>
          </el-table-column>
          <el-table-column prop="amount" label="数量" width="120">
            <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.amount) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="120">
            <template #default="scope">
              <StatusBadge :value="scope.row.status" kind="status" />
            </template>
          </el-table-column>
          <el-table-column label="操作">
            <template #default="scope">
              <el-button size="small" type="danger" @click="cancelOrder(scope.row)">撤单</el-button>
            </template>
          </el-table-column>
        </el-table>

        <h3>触发单</h3>
        <el-table :data="triggerOrders" style="width: 100%" empty-text="无触发单">
            <el-table-column prop="id" label="ID" />
            <el-table-column prop="symbol" label="交易对" />
            <el-table-column label="触发条件">
              <template #default="scope">
                {{ scope.row.trigger?.rule }} {{ formatPrice(scope.row.trigger?.price) }}
              </template>
            </el-table-column>
            <el-table-column label="委托价格">
              <template #default="scope">
                {{ scope.row.price ? formatPrice(scope.row.price) : 'Market' }}
              </template>
            </el-table-column>
            <el-table-column label="操作">
              <template #default="scope">
                <el-button size="small" type="danger" @click="cancelOrder(scope.row)">撤单</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <StrategyDetailDrawer
      v-model:visible="drawerVisible"
      :strategy-id="drawerStrategyId"
      :order-id="drawerOrderId"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onActivated } from 'vue'
import request from '../utils/request'
import { formatPrice } from '../utils/auditFormatters'
import { ElMessage } from 'element-plus'
import { Search, Refresh } from '@element-plus/icons-vue'
import StrategyDetailDrawer from '../components/StrategyDetailDrawer/index.vue'
import OrderAuditLog from '../components/OrderAuditLog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

type OrdersExchangeType = 'gate' | 'gate_tradfi' | 'lighter' | 'binance' | 'virtual_gate'

function resolveExchangeType(row: any): OrdersExchangeType {
  if (!row) return 'gate'
  const instanceId = row.exchangeInstanceId || row.exchangeId
  if (instanceId) {
    const ex = exchanges.value.find((e: any) => e.id === instanceId)
    if (ex) return ex.type
    const n = String(instanceId).toLowerCase()
    if (n.includes('binance')) return 'binance'
    if (n.includes('tradfi') || n.includes('trad')) return 'gate_tradfi'
    if (n.includes('lighter')) return 'lighter'
    if (n.includes('virtual') || n.includes('mock') || n.includes('demo')) return 'virtual_gate'
  }
  return 'gate'
}
import { formatDate, formatContractAmount } from '../utils/format'

const drawerVisible = ref(false)
const drawerStrategyId = ref<number | null>(null)
const drawerOrderId = ref<number | null>(null)

function openStrategyDrawer(strategyId: number, orderId: number) {
  drawerStrategyId.value = strategyId
  drawerOrderId.value = orderId
  drawerVisible.value = true
}

const activeTab = ref('history')
const symbol = ref('BTC_USDT')
const openOrders = ref([])
const triggerOrders = ref([])
const historyOrders = ref([])
const historyLoading = ref(false)
const auditLogsMap = ref<Record<string, any[]>>({})
const loadingMap = ref<Record<string, boolean>>({})
const viewMode = ref(localStorage.getItem('auditLogViewMode') || 'overview')
const historyTable = ref()
const filterSymbol = ref('')
const filterExchange = ref('')
const filterSource = ref('')

const symbols = ref<string[]>([])
const exchanges = ref<any[]>([])
const sources = ref<string[]>([])

const fetchFilters = async () => {
  try {
    const [filterRes, exRes] = await Promise.all([
      request.get('/orders/filters'),
      request.get('/exchanges')
    ])
    symbols.value = filterRes.data.symbols
    sources.value = filterRes.data.sources
    exchanges.value = exRes.data
  } catch (e) {
    console.error('Failed to fetch filters', e)
  }
}

const handleViewModeChange = (val: string | number | boolean) => {
  localStorage.setItem('auditLogViewMode', String(val))
}

const handleRowClick = (row: any) => {
  // Accordion: Close others
  // We iterate through table data and close if it's not the clicked row
  // Note: This relies on table instance.
  // If the clicked row is already expanded, toggleRowExpansion will close it (which is fine).
  // If it's closed, it will open.
  // However, we want to ensure others are closed first.

  // Check if table ref is available
  if (historyTable.value) {
    historyOrders.value.forEach((item: any) => {
      if (item.id !== row.id) {
        // Force close others
        historyTable.value.toggleRowExpansion(item, false)
      }
    })
    // Toggle current
    historyTable.value.toggleRowExpansion(row)
  }
}

const handleExpandChange = async (row: any, expandedRows: any[]) => {
  // If row is expanded (in expandedRows)
  const isExpanded = expandedRows.some(r => r.id === row.id)
  if (isExpanded) {
    // Since we handle single expansion in row-click, we just need to load data here.
    // But expand-change is also triggered by the toggleRowExpansion in row-click.

    if (!auditLogsMap.value[row.id]) {
      loadingMap.value[row.id] = true
      try {
        const res = await request.get(`/orders/${row.id}/audit`)
        auditLogsMap.value[row.id] = res.data
      } catch (error) {
        ElMessage.error('获取追踪记录失败')
      } finally {
        loadingMap.value[row.id] = false
      }
    }
  }
}

const fetchOpenOrders = async () => {
  try {
    const res = await request.get('/orders/open', { params: { symbol: symbol.value } })
    openOrders.value = res.data.openOrders
    triggerOrders.value = res.data.triggerOrders
  } catch (error) {
    ElMessage.error('获取挂单失败')
  }
}

const fetchHistoryOrders = async () => {
  historyLoading.value = true
  try {
    const params: any = { limit: 50 }
    if (filterSymbol.value) params.symbol = filterSymbol.value
    if (filterExchange.value) params.exchange = filterExchange.value
    if (filterSource.value) params.source = filterSource.value

    const res = await request.get('/orders/history', { params })
    historyOrders.value = res.data
  } catch (error) {
    ElMessage.error('获取历史订单失败')
  } finally {
    historyLoading.value = false
  }
}

function formatPnl(pnl: any): string {
  const n = Number(pnl)
  if (!Number.isFinite(n)) return String(pnl ?? '')
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

function pnlClass(pnl: any): string {
  const n = Number(pnl)
  if (!Number.isFinite(n) || n === 0) return 'pnl-empty'
  return n > 0 ? 'pnl-positive' : 'pnl-negative'
}

const cancelOrder = async (_order: any) => {
  // This is tricky because backend expects an internal order ID for /api/orders/:id/cancel
  // But here we might be listing exchange orders which might not be persisted or ID mismatch.
  // The current backend API /api/orders/:id/cancel uses the internal order ID.
  // We need an API to cancel by Exchange ID + Symbol.
  // Current implementation relies on the internal order ID.
  // If we want to cancel exchange orders directly, we should update backend API or add new one.
  // For now, let's assume we can only view. Or unimplemented.
  ElMessage.warning('目前仅支持查看，撤单需通过内部订单 ID 或新接口支持')
}

watch(activeTab, (val: string) => {
  if (val === 'history') {
    fetchHistoryOrders()
  } else {
    fetchOpenOrders()
  }
})

onMounted(() => {
  fetchFilters()
  if (activeTab.value === 'history') {
    fetchHistoryOrders()
  } else {
    fetchOpenOrders()
  }
})

onActivated(() => {
  if (activeTab.value === 'history') {
    fetchHistoryOrders()
  } else {
    fetchOpenOrders()
  }
})
</script>

<style scoped>
/* Custom Tabs */
:deep(.el-tabs__header) {
  margin-bottom: 24px;
}

:deep(.el-tabs__item) {
  color: var(--text-color-secondary);
  font-size: 14px;
}

:deep(.el-tabs__item.is-active) {
  color: var(--color-primary-start);
  font-weight: 600;
}

:deep(.el-tabs__active-bar) {
  background-color: var(--color-primary-start);
}

.no-logs {
  text-align: center;
  color: #999;
  padding: 10px;
}

.strategy-link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: underline;
}
.strategy-link:hover {
  color: var(--el-color-primary-dark-2);
}

.pnl-text {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.pnl-positive {
  color: var(--el-color-success);
}
.pnl-negative {
  color: var(--el-color-danger);
}
.pnl-empty {
  color: #999;
}

</style>
