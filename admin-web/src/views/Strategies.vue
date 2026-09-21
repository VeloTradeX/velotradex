<template>
  <div class="page-container">
    <!-- Filter Card -->
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
           <el-select 
             v-model="parserFilter" 
             placeholder="按解析器筛选 (Parser)" 
             style="width: 250px;" 
             clearable 
             filterable
             @change="fetchData"
             @clear="fetchData"
           >
             <el-option
                v-for="item in parsers"
                :key="item.name"
                :label="item.name"
                :value="item.name"
              />
           </el-select>
           <el-select
             v-model="symbolFilter"
             placeholder="按交易对筛选"
             style="width: 220px;"
             clearable
             filterable
             allow-create
             default-first-option
             @change="handleSymbolChange"
             @clear="handleSymbolClear"
           >
             <el-option
               v-for="item in symbolOptions"
               :key="item"
               :label="item"
               :value="item"
             />
           </el-select>
           <el-button :icon="Refresh" @click="fetchData">刷新</el-button>
           <el-button type="primary" :icon="Message" @click="sendMessageDialogVisible = true">发送消息</el-button>
           <el-button type="success" :icon="Cpu" @click="parseMessageDialogVisible = true">解析验证</el-button>
        </div>
      </div>
    </el-card>

    <!-- Content Area -->
    <div class="content-area">
      <el-table :data="strategies" style="width: 100%" v-loading="loading" class="data-table" @row-click="handleRowClick">
        <el-table-column prop="id" label="ID" width="80">
          <template #default="scope">
            <el-button size="small" type="text" @click="showRawMessage(scope.row)">{{ scope.row.id }}</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="parserName" label="解析器" width="150" show-overflow-tooltip />
        <el-table-column prop="createdAt" label="时间" width="180">
          <template #default="scope">
            {{ formatDate(scope.row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column prop="symbol" label="交易对" width="120" />
        <el-table-column prop="action" label="动作" width="110" show-overflow-tooltip />
        <el-table-column prop="side" label="方向" width="90" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="110" show-overflow-tooltip />
        <el-table-column label="路由结果" min-width="190">
          <template #default="scope">
            <div v-if="scope.row.routes">
              <div v-for="(route, idx) in parseRoutes(scope.row.routes)" :key="idx" class="route-row">
                <el-tag size="small" effect="plain" class="route-exchange-tag">
                  <span class="route-exchange-logo">
                    <ExchangeLogo :type="resolveRouteExchangeType(route)" size="xs" />
                  </span>
                  <span class="route-exchange-name">{{ route.exchangeName || route.exchangeInstanceId || 'Unknown' }}</span>
                </el-tag>
                <el-tooltip v-if="route.reason || route.error" :content="route.reason || route.error" placement="top">
                  <StatusBadge :value="route.status" kind="status" size="small" />
                </el-tooltip>
                <StatusBadge v-else :value="route.status" kind="status" size="small" />
              </div>
            </div>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="订单" width="80" align="center">
          <template #default="{ row }">
            <el-badge
              v-if="row.orderCount > 0"
              :value="row.orderCount"
              type="primary"
            />
            <el-badge
              v-else
              :value="0"
              type="info"
            />
          </template>
        </el-table-column>
        <el-table-column label="原始消息">
          <template #default="scope">
            <el-button size="small" @click="showRawMessage(scope.row)">查看详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- Raw Message Detail Dialog -->
    <StrategyRawMessageDialog
      v-model="rawMessageDialogVisible"
      :strategy="selectedStrategy"
    />

    <!-- Send Message Dialog -->
    <StrategySendMessageDialog v-model="sendMessageDialogVisible" />

    <!-- Parse Message Dialog -->
    <StrategyParseMessageDialog v-model="parseMessageDialogVisible" />

    <StrategyDetailDrawer
      v-model:visible="drawerVisible"
      :strategy-id="drawerStrategyId"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import request from '../utils/request'
import { Message, Cpu, Refresh } from '@element-plus/icons-vue'
import StrategyDetailDrawer from '../components/StrategyDetailDrawer/index.vue'
import StrategyRawMessageDialog from '../components/StrategyRawMessageDialog.vue'
import StrategySendMessageDialog from '../components/StrategySendMessageDialog.vue'
import StrategyParseMessageDialog from '../components/StrategyParseMessageDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

type StratExchangeType = 'gate' | 'gate_tradfi' | 'lighter' | 'binance' | 'virtual_gate'

function resolveRouteExchangeType(route: any): StratExchangeType {
  const instanceId = route.exchangeInstanceId || route.exchangeId
  if (instanceId) {
    const found = allExchanges.value.find((e: any) => e.id === instanceId)
    if (found) return found.type
  }
  const name = String(route.exchangeName || route.exchangeInstanceId || '').toLowerCase()
  if (name.includes('binance')) return 'binance'
  if (name.includes('tradfi') || name.includes('trad')) return 'gate_tradfi'
  if (name.includes('lighter')) return 'lighter'
  if (name.includes('virtual') || name.includes('mock') || name.includes('demo')) return 'virtual_gate'
  return 'gate'
}
import { formatDate } from '../utils/format'

const drawerVisible = ref(false)
const drawerStrategyId = ref<number | null>(null)

function openStrategyDrawer(strategyId: number) {
  drawerStrategyId.value = strategyId
  drawerVisible.value = true
}

function handleRowClick(row: any, column: any) {
  // 排除按钮点击区域（操作列/原始消息列）
  if (column.label === '原始消息' || column.property === 'id') return
  openStrategyDrawer(row.id)
}

const strategies = ref<any[]>([])
const loading = ref(false)
const parserFilter = ref('')
const symbolFilter = ref('')
const symbolOptions = ref<string[]>([])

// Dialog visibility
const rawMessageDialogVisible = ref(false)
const sendMessageDialogVisible = ref(false)
const parseMessageDialogVisible = ref(false)
const selectedStrategy = ref<any>(null)

// Parsers used by the filter dropdown
const parsers = ref<any[]>([])
// All exchange instances — used to resolve logo by route name/id
const allExchanges = ref<any[]>([])

const fetchData = async () => {
  loading.value = true
  try {
    const params: any = { limit: 100 }
    if (parserFilter.value) {
      params.parser = parserFilter.value
    }
    if (symbolFilter.value) {
      params.symbol = symbolFilter.value
    }
    const [stratRes, exchRes] = await Promise.all([
      request.get('/strategies', { params }),
      request.get('/exchanges').catch(() => ({ data: [] }))
    ])
    strategies.value = stratRes.data
    allExchanges.value = exchRes.data || []
    updateSymbolOptions()
  } catch (error) {
    console.error(error)
  } finally {
    loading.value = false
  }
}

const updateSymbolOptions = () => {
  const symbols = strategies.value
    .map((s: any) => s.symbol)
    .filter((s: string) => !!s)
  const merged = new Set([...symbolOptions.value, ...symbols])
  if (symbolFilter.value) {
    merged.add(symbolFilter.value)
  }
  symbolOptions.value = Array.from(merged).sort()
}

const handleSymbolChange = (value: string) => {
  symbolFilter.value = value ? value.toUpperCase() : ''
  fetchData()
}

const handleSymbolClear = () => {
  symbolFilter.value = ''
  fetchData()
}

const showRawMessage = (strategy: any) => {
  selectedStrategy.value = strategy
  rawMessageDialogVisible.value = true
}

const parseRoutes = (routesJson: string) => {
  try {
    if (!routesJson) return []
    const parsed = JSON.parse(routesJson)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

const fetchParsers = async () => {
  try {
    const res = await request.get('/parsers')
    parsers.value = res.data
  } catch (e) {
    console.error(e)
  }
}

onMounted(() => {
  fetchParsers()
  fetchData()
})
</script>

<style scoped>
.route-row {
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.route-exchange-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 10px 2px 8px;
  border-radius: 999px;
}

.route-exchange-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.route-exchange-name {
  color: var(--text-color-primary);
  font-size: 12px;
  line-height: 1;
}

:deep(.el-table__body tr) {
  cursor: pointer;
}
</style>
