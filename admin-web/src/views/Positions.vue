<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-select
            v-model="selectedExchange"
            placeholder="请选择交易所"
            style="width: 260px"
            @change="handleExchangeChange"
          >
            <el-option
              v-for="item in exchanges"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            >
              <div class="option-with-logo">
                <ExchangeLogo :type="item.type" size="sm" />
                <span class="name-text">{{ item.name }}</span>
                <span style="margin-left:auto;color:#999;font-size:12px;">{{ item.id }}</span>
              </div>
            </el-option>
          </el-select>
          <el-button type="primary" :icon="Refresh" @click="refreshData" :loading="loading">刷新</el-button>
        </div>
      </div>
    </el-card>

    <div class="content-area">
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="当前持仓" name="current">
            <el-table :data="positions" style="width: 100%" v-loading="loading" class="data-table">
            <el-table-column label="交易所" width="180" show-overflow-tooltip>
              <template #default="scope">
                <div class="cell-with-logo">
                  <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
                  <span>{{ scope.row.exchangeName || scope.row.exchange || '-' }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="symbol" label="交易对" width="150" />
            <el-table-column prop="size" label="持仓数量" width="120">
                <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.size) }}</template>
            </el-table-column>
            <el-table-column prop="entryPrice" label="开仓价格">
                <template #default="scope">{{ formatPrice(scope.row.entryPrice) }}</template>
            </el-table-column>
            <el-table-column prop="markPrice" label="标记价格">
                <template #default="scope">{{ formatPrice(scope.row.markPrice) }}</template>
            </el-table-column>
            <el-table-column prop="unrealizedPnl" label="未实现盈亏">
                <template #default="scope">
                    <span :class="getPnlClass(scope.row.unrealizedPnl)">{{ formatPrice(scope.row.unrealizedPnl) }}</span>
                </template>
            </el-table-column>
            <el-table-column prop="leverage" label="杠杆" width="100" />
            <el-table-column label="操作" fixed="right" width="120">
                <template #default="scope">
                <el-popconfirm title="确定要市价平仓吗?" @confirm="closePosition(scope.row)">
                    <template #reference>
                    <el-button size="small" type="danger">市价平仓</el-button>
                    </template>
                </el-popconfirm>
                </template>
            </el-table-column>
            </el-table>
        </el-tab-pane>

        <el-tab-pane label="历史委托" name="orders">
            <el-table :data="orderList" style="width: 100%" v-loading="ordersLoading" class="data-table" empty-text="暂无历史委托">
                <el-table-column prop="createdAt" label="时间" width="180">
                    <template #default="scope">{{ formatDate(scope.row.createdAt) }}</template>
                </el-table-column>
                <el-table-column prop="symbol" label="交易对" width="150" />
                <el-table-column prop="price" label="委托价格" width="120">
                    <template #default="scope">{{ formatPrice(scope.row.price) }}</template>
                </el-table-column>
                <el-table-column prop="filledPrice" label="成交价格" width="120">
                    <template #default="scope">{{ formatPrice(scope.row.filledPrice) }}</template>
                </el-table-column>
                <el-table-column prop="filledAmount" label="成交数量" width="120">
                    <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.filledAmount) }}</template>
                </el-table-column>
                <el-table-column prop="realizedPnl" label="平仓盈亏">
                    <template #default="scope">
                        <span :class="getPnlClass(scope.row.realizedPnl)">{{ formatPrice(scope.row.realizedPnl) }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="pnlPercent" label="平仓盈亏率" width="120">
                    <template #default="scope">
                        <span :class="getPnlClass(scope.row.pnlPercent)">{{ formatPercent(scope.row.pnlPercent) }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="leverage" label="杠杆" width="90">
                    <template #default="scope">{{ formatNullable(scope.row.leverage) }}x</template>
                </el-table-column>
                <el-table-column prop="side" label="方向" width="100">
                    <template #default="scope">
                        <StatusBadge :value="scope.row.side" kind="side" />
                    </template>
                </el-table-column>
            </el-table>

            <div class="pagination-container">
                <el-pagination
                    v-model:current-page="ordersPage"
                    v-model:page-size="ordersPageSize"
                    :page-sizes="[20, 50, 100]"
                    layout="total, sizes, prev, pager, next, jumper"
                    :total="ordersTotal"
                    @size-change="handleOrdersSizeChange"
                    @current-change="handleOrdersPageChange"
                />
            </div>
        </el-tab-pane>

        <el-tab-pane label="历史仓位" name="history">
            <el-table :data="historyPositions" style="width: 100%" v-loading="historyLoading" class="data-table" border>
                <el-table-column label="交易所" width="180" show-overflow-tooltip>
                  <template #default="scope">
                    <div class="cell-with-logo">
                      <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
                      <span>{{ scope.row.exchange || scope.row.exchangeName || '-' }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column prop="symbol" label="交易对" width="150" />
                <el-table-column prop="side" label="Side" width="100">
                     <template #default="scope">
                        <StatusBadge :value="scope.row.side" kind="side" />
                    </template>
                </el-table-column>
                <el-table-column prop="amount" label="持仓数量" width="120">
                     <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.amount) }}</template>
                </el-table-column>
                <el-table-column prop="price" label="开仓价格">
                     <template #default="scope">{{ formatPrice(scope.row.price) }}</template>
                </el-table-column>
                <el-table-column prop="exitPrice" label="平仓价格">
                     <template #default="scope">{{ formatPrice(scope.row.exitPrice) }}</template>
                </el-table-column>
                <el-table-column prop="realizedPnl" label="已实现盈亏">
                    <template #default="scope">
                         <span :class="getPnlClass(scope.row.realizedPnl)">{{ formatPrice(scope.row.realizedPnl) }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="closedAt" label="平仓时间" width="180">
                    <template #default="scope">{{ formatDate(scope.row.closedAt) }}</template>
                </el-table-column>
            </el-table>

            <div class="pagination-container">
                <el-pagination
                    v-model:current-page="historyPage"
                    v-model:page-size="historyPageSize"
                    :page-sizes="[20, 50, 100]"
                    layout="total, sizes, prev, pager, next, jumper"
                    :total="historyTotal"
                    @size-change="handleHistorySizeChange"
                    @current-change="handleHistoryPageChange"
                />
            </div>
        </el-tab-pane>

        <el-tab-pane label="成交记录" name="fills">
            <el-table :data="fills" style="width: 100%" v-loading="fillsLoading" class="data-table" empty-text="暂无成交记录">
                <el-table-column label="时间" width="180">
                    <template #default="scope">{{ formatDate(scope.row.time) }}</template>
                </el-table-column>
                <el-table-column prop="symbol" label="交易对" width="150" />
                <el-table-column prop="side" label="方向" width="100">
                    <template #default="scope">
                        <StatusBadge :value="scope.row.side" kind="side" />
                    </template>
                </el-table-column>
                <el-table-column prop="price" label="价格" width="130">
                    <template #default="scope">{{ formatPrice(scope.row.price) }}</template>
                </el-table-column>
                <el-table-column prop="amount" label="数量" width="130">
                    <template #default="scope">{{ formatContractAmount(scope.row.symbol, scope.row.amount) }}</template>
                </el-table-column>
                <el-table-column prop="role" label="角色" width="90" />
                <el-table-column label="成交盈亏" width="120">
                    <template #default="scope">
                        <span v-if="scope.row.realizedPnl !== undefined && scope.row.realizedPnl !== null" :class="getPnlClass(scope.row.realizedPnl)">{{ formatPrice(scope.row.realizedPnl) }}</span>
                        <span v-else>-</span>
                    </template>
                </el-table-column>
                <el-table-column prop="id" label="成交 ID" min-width="170" show-overflow-tooltip />
                <el-table-column prop="orderId" label="订单 ID" min-width="180" show-overflow-tooltip />
            </el-table>
        </el-tab-pane>

        <el-tab-pane label="资金流水" name="funds">
            <el-row :gutter="16" class="fund-balance-row">
                <el-col :span="8">
                    <div class="balance-card">
                        <div class="balance-label">总余额</div>
                        <div class="balance-value">{{ balance ? formatFixed(balance.total) : '-' }}</div>
                    </div>
                </el-col>
                <el-col :span="8">
                    <div class="balance-card">
                        <div class="balance-label">可用余额</div>
                        <div class="balance-value">{{ balance ? formatFixed(balance.available) : '-' }}</div>
                    </div>
                </el-col>
                <el-col :span="8">
                    <div class="balance-card">
                        <div class="balance-label">未实现盈亏</div>
                        <div class="balance-value" :class="getPnlClass(balance && balance.unrealizedPnl)">{{ balance ? formatFixed(balance.unrealizedPnl) : '-' }}</div>
                    </div>
                </el-col>
            </el-row>

            <el-table :data="fundEntries" style="width: 100%" v-loading="fundsLoading" class="data-table" empty-text="暂无资金流水">
                <el-table-column label="时间" width="180">
                    <template #default="scope">{{ formatDate(scope.row.time) }}</template>
                </el-table-column>
                <el-table-column prop="typeLabel" label="类型" width="120" />
                <el-table-column label="金额" width="150">
                    <template #default="scope">
                        <span v-if="scope.row.amount !== null && scope.row.amount !== undefined" :class="getPnlClass(scope.row.amount)">{{ formatFixed(scope.row.amount) }}</span>
                        <span v-else>-</span>
                    </template>
                </el-table-column>
                <el-table-column prop="currency" label="币种" width="90" />
                <el-table-column prop="symbol" label="交易对" width="150">
                    <template #default="scope">{{ scope.row.symbol || '-' }}</template>
                </el-table-column>
                <el-table-column prop="note" label="备注" />
            </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { formatPrice, formatDate, formatContractAmount, formatFixed, formatNullable } from '../utils/format'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

type ExchangeType = 'gate' | 'gate_tradfi' | 'lighter' | 'binance' | 'virtual_gate'

const positions = ref([])
const loading = ref(false)
const exchanges = ref<any[]>([])
const selectedExchange = ref('')
const activeTab = ref('current')

// 历史委托
const orderList = ref([])
const ordersLoading = ref(false)
const ordersPage = ref(1)
const ordersPageSize = ref(20)
const ordersTotal = ref(0)

// 历史仓位
const historyPositions = ref([])
const historyLoading = ref(false)
const historyPage = ref(1)
const historyPageSize = ref(20)
const historyTotal = ref(0)

// 成交记录
const fills = ref([])
const fillsLoading = ref(false)

// 资金流水
const balance = ref<any>(null)
const fundEntries = ref([])
const fundsLoading = ref(false)

const getPnlClass = (val: string | number | null | undefined) => {
    if (val === null || val === undefined || val === '') return ''
    const num = Number(val)
    if (isNaN(num)) return ''
    return num > 0 ? 'text-success' : (num < 0 ? 'text-danger' : '')
}

const formatPercent = (val: string | number | null | undefined) => {
    if (val === null || val === undefined || val === '') return '-'
    const num = Number(val)
    if (isNaN(num)) return String(val)
    return `${num.toFixed(2)}%`
}

/** 根据行数据（匹配名称或ID）推断交易所类型，找不到默认 gate */
const resolveExchangeType = (row: any): ExchangeType => {
  if (!row) return 'gate'
  const instanceId = row.exchangeInstanceId || row.exchangeId
  if (instanceId) {
    const found = exchanges.value.find(e => e.id === instanceId)
    if (found) return found.type
  }
  const name = (row.exchangeName || row.exchange || '') as string
  if (name) {
    const byName = exchanges.value.find(e =>
      e.name === name ||
      e.id === name ||
      name.includes(e.id) ||
      name.includes(e.name)
    )
    if (byName) return byName.type
    const n = String(name).toLowerCase()
    if (n.includes('binance')) return 'binance'
    if (n.includes('tradfi') || n.includes('trad') || n.includes('stock')) return 'gate_tradfi'
    if (n.includes('lighter')) return 'lighter'
    if (n.includes('virtual') || n.includes('mock') || n.includes('demo')) return 'virtual_gate'
  }
  return 'gate'
}

const fetchExchanges = async () => {
    try {
        const res = await request.get('/exchanges')
        exchanges.value = res.data
        if (!selectedExchange.value && exchanges.value.length > 0) {
            selectedExchange.value = exchanges.value[0].id
        }
    } catch (e) {
        console.error(e)
    }
}

const fetchPositions = async () => {
  if (!selectedExchange.value) return
  loading.value = true
  try {
    const params: any = { exchangeInstanceId: selectedExchange.value }
    const res = await request.get('/positions', { params })
    positions.value = res.data
  } catch (error) {
    ElMessage.error('获取持仓失败')
  } finally {
    loading.value = false
  }
}

const fetchOrders = async () => {
    if (!selectedExchange.value) return
    ordersLoading.value = true
    try {
        const res = await request.get('/trades/orders', {
            params: {
                exchangeInstanceId: selectedExchange.value,
                page: ordersPage.value,
                pageSize: ordersPageSize.value
            }
        })
        orderList.value = res.data.data
        ordersTotal.value = res.data.total
    } catch (error) {
        ElMessage.error('获取历史委托失败')
    } finally {
        ordersLoading.value = false
    }
}

const fetchHistory = async () => {
    if (!selectedExchange.value) return
    historyLoading.value = true
    try {
        const res = await request.get('/positions/history', {
            params: {
                page: historyPage.value,
                pageSize: historyPageSize.value,
                exchangeInstanceId: selectedExchange.value
            }
        })
        historyPositions.value = res.data.data
        historyTotal.value = res.data.total
    } catch (error) {
        ElMessage.error('获取历史仓位失败')
    } finally {
        historyLoading.value = false
    }
}

const fetchFills = async () => {
    if (!selectedExchange.value) return
    fillsLoading.value = true
    try {
        const res = await request.get('/trades/fills', {
            params: { exchangeInstanceId: selectedExchange.value, limit: 200 }
        })
        fills.value = res.data
    } catch (error) {
        ElMessage.error('获取成交记录失败')
    } finally {
        fillsLoading.value = false
    }
}

const fetchFunds = async () => {
    if (!selectedExchange.value) return
    fundsLoading.value = true
    try {
        const res = await request.get('/trades/funds', {
            params: { exchangeInstanceId: selectedExchange.value }
        })
        balance.value = res.data.balance
        fundEntries.value = res.data.entries
    } catch (error) {
        ElMessage.error('获取资金流水失败')
    } finally {
        fundsLoading.value = false
    }
}

const refreshData = () => {
    if (!selectedExchange.value) return
    switch (activeTab.value) {
        case 'current':
            fetchPositions(); break
        case 'orders':
            fetchOrders(); break
        case 'history':
            fetchHistory(); break
        case 'fills':
            fetchFills(); break
        case 'funds':
            fetchFunds(); break
    }
}

const handleExchangeChange = () => {
    refreshData()
}

const handleTabChange = () => {
    refreshData()
}

const handleOrdersSizeChange = (val: number) => {
    ordersPageSize.value = val
    ordersPage.value = 1
    fetchOrders()
}

const handleOrdersPageChange = () => {
    fetchOrders()
}

const handleHistorySizeChange = (val: number) => {
    historyPageSize.value = val
    historyPage.value = 1
    fetchHistory()
}

const handleHistoryPageChange = () => {
    fetchHistory()
}

const closePosition = async (position: any) => {
  try {
    const size = parseFloat(position.size)
    if (size === 0) return
    const side = size > 0 ? 'sell' : 'buy'
    await request.post('/positions/close', {
      symbol: position.symbol,
      side: side,
      exchangeInstanceId: position.exchangeInstanceId
    })
    ElMessage.success('平仓请求已发送')
    setTimeout(fetchPositions, 1000)
  } catch (error) {
    ElMessage.error('平仓失败')
  }
}

onMounted(async () => {
  await fetchExchanges()
  refreshData()
})
</script>

<style scoped>
.filter-card {
  margin-bottom: 12px;
}
.text-success {
    color: #67c23a;
}
.text-danger {
    color: #f56c6c;
}
.pagination-container {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
}
.fund-balance-row {
    margin-bottom: 20px;
}
.balance-card {
    background: var(--bg-color-base, #f7f8fa);
    border: 1px solid var(--border-color-lighter, #ebeef5);
    border-radius: 8px;
    padding: 16px;
    box-sizing: border-box;
    text-align: center;
}
.balance-label {
    font-size: 13px;
    color: var(--text-color-secondary, #909399);
    margin-bottom: 8px;
}
.balance-value {
    font-size: 22px;
    font-weight: 600;
    color: var(--text-color-primary, #303133);
}
:deep(.el-tabs__header) {
    margin-bottom: 16px;
}
</style>