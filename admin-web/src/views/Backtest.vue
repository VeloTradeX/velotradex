<template>
  <div class="page-container">
    <!-- ── 创建回测 ── -->
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-upload
            :auto-upload="false"
            :limit="1"
            :on-change="handleFileChange"
            :on-remove="() => (form.file = null)"
            accept=".json"
            class="upload-input"
          >
            <el-button :icon="UploadFilled">{{ form.file ? form.file.name : '选择消息 JSON 文件' }}</el-button>
          </el-upload>

          <el-input v-model="form.name" placeholder="回测名称（可选）" style="width: 200px" />

          <el-select
            v-model="form.routeId"
            placeholder="选择信号路由"
            style="width: 260px"
            filterable
          >
            <el-option
              v-for="route in routes"
              :key="route.id"
              :label="`${route.name} (${route.channelId})`"
              :value="route.id"
            />
          </el-select>

          <el-input-number v-model="form.initialBalance" :min="1" :step="100" style="width: 140px" />

          <el-input
            v-model="form.symbolsHint"
            placeholder="品种提示（可选，逗号分隔）"
            style="width: 220px"
          />

          <el-button type="primary" :icon="VideoPlay" :loading="creating" @click="handleCreate">
            开始回测
          </el-button>
        </div>
      </div>
      <div class="upload-tip">
        支持导入预处理后的 Discord 历史消息（如 kacang.json / mansoor.json 格式）。
        系统将在隔离环境中按 1 分钟 K 线高速重放：消息解析 → 信号路由 → 虚拟下单 → 挂单撮合 → 仓位运行 → 止盈止损平仓，全过程时间戳按原始信号时间记录。
      </div>
    </el-card>

    <!-- ── 回测列表 ── -->
    <div class="content-area">
      <el-table :data="runs" style="width: 100%" v-loading="loading" class="data-table">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.name }}
            <div class="sub-text">{{ row.runKey }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="dark">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="消息时间范围" width="300">
          <template #default="{ row }">
            <span v-if="row.rangeStart">{{ formatDate(row.rangeStart) }} ~ {{ formatDate(row.rangeEnd) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="消息数" width="80" align="center">
          <template #default="{ row }">{{ row.messageCount }}</template>
        </el-table-column>
        <el-table-column label="进度" min-width="220">
          <template #default="{ row }">
            <div v-if="isRunning(row)">
              <el-progress
                :percentage="progressPercent(row)"
                :stroke-width="14"
                :status="progressPercent(row) >= 100 ? 'success' : undefined"
              />
              <div class="sub-text">{{ progressText(row) }}</div>
            </div>
            <span v-else class="sub-text">{{ row.progress?.phase || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最终权益" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.summary">{{ formatFixed(row.summary.finalEquity, 2) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="净盈亏" width="110" align="right">
          <template #default="{ row }">
            <span
              v-if="row.summary"
              :class="Number(row.summary.realizedPnl) >= 0 ? 'text-success' : 'text-danger'"
            >
              {{ formatFixed(row.summary.realizedPnl, 2) }}
            </span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="胜率" width="90" align="right">
          <template #default="{ row }">
            <span v-if="row.summary">{{ row.summary.winRate?.toFixed(1) }}%</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail(row)">详情</el-button>
            <el-button
              v-if="isRunning(row)"
              size="small"
              type="warning"
              :loading="stoppingId === row.id"
              @click="handleStop(row)"
            >停止</el-button>
            <el-button size="small" type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ── 详情抽屉 ── -->
    <el-drawer v-model="detailVisible" size="62%" :title="detailRun ? `回测 #${detailRun.id} ${detailRun.name}` : '回测详情'">
      <template v-if="detailRun">
        <el-alert
          v-if="detailRun.error"
          type="error"
          :title="detailRun.error"
          :closable="false"
          style="margin-bottom: 16px"
        />

        <el-descriptions :column="3" border size="small" style="margin-bottom: 16px">
          <el-descriptions-item label="状态">{{ statusText(detailRun.status) }}</el-descriptions-item>
          <el-descriptions-item label="解析器">{{ detailRun.parserName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="信号路由">{{ detailRun.config?.routeName || detailRun.routeId }}</el-descriptions-item>
          <el-descriptions-item label="消息数">{{ detailRun.messageCount }}</el-descriptions-item>
          <el-descriptions-item label="回放区间" :span="2">
            {{ detailRun.summary ? `${formatDate(detailRun.summary.simStart)} ~ ${formatDate(detailRun.summary.simEnd)}` : '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="初始资金">{{ detailRun.summary?.initialBalance ?? detailRun.config?.initialBalance ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="最终权益">
            <span v-if="detailRun.summary">{{ formatFixed(detailRun.summary.finalEquity, 2) }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="净盈亏">
            <span v-if="detailRun.summary" :class="Number(detailRun.summary.realizedPnl) >= 0 ? 'text-success' : 'text-danger'">
              {{ formatFixed(detailRun.summary.realizedPnl, 2) }}
            </span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="未实现盈亏">
            <span v-if="detailRun.summary">{{ formatFixed(detailRun.summary.unrealizedPnl, 2) }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="最大回撤">
            <span v-if="detailRun.summary">{{ formatFixed(detailRun.summary.maxDrawdown, 2) }} ({{ detailRun.summary.maxDrawdownPct?.toFixed(2) }}%)</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="胜率">
            <span v-if="detailRun.summary">{{ detailRun.summary.winRate?.toFixed(1) }}% ({{ detailRun.summary.wins }}胜 / {{ detailRun.summary.losses }}负)</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="策略 / 订单">
            <span v-if="detailRun.summary">{{ detailRun.summary.totalStrategies }} / {{ detailRun.summary.totalOrders }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="成交 / 成交数">
            <span v-if="detailRun.summary">{{ detailRun.summary.filledOrders }} / {{ detailRun.summary.totalTrades }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="撤单 / 挂单">
            <span v-if="detailRun.summary">{{ detailRun.summary.cancelledOrders }} / {{ detailRun.summary.pendingOrders }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
        </el-descriptions>

        <div v-if="detailRun.summary" class="detail-sections">
          <el-card shadow="never" class="section-card">
            <template #header>权益曲线</template>
            <div id="backtest-equity-chart" class="equity-chart"></div>
          </el-card>

          <el-row :gutter="16">
            <el-col :span="12">
              <el-card shadow="never" class="section-card">
                <template #header>月度盈亏</template>
                <el-table :data="monthRows" size="small" max-height="300">
                  <el-table-column prop="month" label="月份" width="100" />
                  <el-table-column label="成交数" width="80" align="center">
                    <template #default="{ row }">{{ row.trades }}</template>
                  </el-table-column>
                  <el-table-column label="盈亏" align="right">
                    <template #default="{ row }">
                      <span :class="row.realizedPnl >= 0 ? 'text-success' : 'text-danger'">{{ formatFixed(row.realizedPnl, 2) }}</span>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>
            </el-col>
            <el-col :span="12">
              <el-card shadow="never" class="section-card">
                <template #header>品种盈亏</template>
                <el-table :data="symbolRows" size="small" max-height="300">
                  <el-table-column prop="symbol" label="品种" width="140" />
                  <el-table-column label="成交数" width="80" align="center">
                    <template #default="{ row }">{{ row.trades }}</template>
                  </el-table-column>
                  <el-table-column label="盈亏" align="right">
                    <template #default="{ row }">
                      <span :class="row.realizedPnl >= 0 ? 'text-success' : 'text-danger'">{{ formatFixed(row.realizedPnl, 2) }}</span>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>
            </el-col>
          </el-row>
        </div>

        <div class="detail-actions">
          <el-button
            v-if="detailRun.status === 'completed' || detailRun.status === 'stopped'"
            type="primary"
            @click="router.push({ path: '/statistics', query: { backtestRunId: detailRun.id } })"
          >查看统计</el-button>
          <el-button
            v-if="detailRun.status === 'completed' || detailRun.status === 'stopped'"
            :loading="reimporting"
            @click="handleReimport"
          >重新导入</el-button>
          <el-button
            @click="router.push({ path: '/strategies', query: { backtestRunId: detailRun.id } })"
          >查看策略</el-button>
          <el-button
            @click="router.push({ path: '/orders', query: { backtestRunId: detailRun.id } })"
          >查看订单</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled, VideoPlay } from '@element-plus/icons-vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import request from '../utils/request'
import { formatDate, formatFixed } from '../utils/format'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

const router = useRouter()

// ── 创建表单 ──
const routes = ref<any[]>([])
const creating = ref(false)
const form = ref<{ file: File | null; name: string; routeId: number | undefined; initialBalance: number; symbolsHint: string }>({
  file: null,
  name: '',
  routeId: undefined,
  initialBalance: 1000,
  symbolsHint: '',
})

const handleFileChange = (file: any) => {
  form.value.file = file.raw
}

const fetchRoutes = async () => {
  try {
    const res = await request.get('/routes')
    routes.value = (res.data || []).filter((r: any) => r.isActive)
  } catch {
    ElMessage.error('获取信号路由列表失败')
  }
}

const handleCreate = async () => {
  if (!form.value.file) {
    ElMessage.warning('请先选择消息 JSON 文件')
    return
  }
  if (!form.value.routeId) {
    ElMessage.warning('请选择信号路由')
    return
  }
  creating.value = true
  try {
    const fd = new FormData()
    fd.append('file', form.value.file)
    fd.append('name', form.value.name || `回测 ${new Date().toLocaleString()}`)
    fd.append('routeId', String(form.value.routeId))
    fd.append('initialBalance', String(form.value.initialBalance))
    if (form.value.symbolsHint.trim()) fd.append('symbolsHint', form.value.symbolsHint.trim())

    const res = await request.post('/backtest/runs', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    })
    ElMessage.success(`回测 #${res.data.id} 已启动`)
    form.value = { file: null, name: '', routeId: form.value.routeId, initialBalance: form.value.initialBalance, symbolsHint: '' }
    await fetchRuns()
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '启动回测失败'
    ElMessage.error(String(msg))
  } finally {
    creating.value = false
  }
}

// ── 运行列表（轮询） ──
const runs = ref<any[]>([])
const loading = ref(false)
const stoppingId = ref<number | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let detailRunId: number | null = null

const isRunning = (row: any) => ['running', 'preparing', 'pending'].includes(row.status)

const fetchRuns = async () => {
  try {
    const res = await request.get('/backtest/runs')
    runs.value = res.data || []
    // 详情抽屉打开时同步刷新其中数据
    if (detailRunId != null) {
      const fresh = runs.value.find((r: any) => r.id === detailRunId)
      if (fresh) detailRun.value = fresh
    }
  } catch {
    // 静默失败，下次轮询重试
  }
}

const progressPercent = (row: any) => {
  const p = row.progress
  if (!p || !Number.isFinite(p.candlesTotal) || p.candlesTotal <= 0) return 0
  return Math.min(100, Math.round(((p.candlesDone || 0) / p.candlesTotal) * 100))
}

const progressText = (row: any) => {
  const p = row.progress || {}
  const parts: string[] = []
  if (p.phase) parts.push(phaseText(p.phase))
  if (p.simTime) parts.push(`K线 ${formatDate(p.simTime)}`)
  if (Number.isFinite(p.candlesDone) && Number.isFinite(p.candlesTotal)) {
    parts.push(`${p.candlesDone}/${p.candlesTotal} 分钟`)
  }
  if (Number.isFinite(p.messagesProcessed) && Number.isFinite(p.messagesTotal)) {
    parts.push(`消息 ${p.messagesProcessed}/${p.messagesTotal}`)
  }
  return parts.join(' · ')
}

const phaseText = (phase: string) => ({
  preparing: '准备中',
  preParse: '预解析消息',
  fetchCandles: '拉取历史 K 线',
  replaying: '逐分钟回放中',
  exporting: '导出结果',
  failed: '失败',
}[phase] || phase)

const statusText = (status: string) => ({
  pending: '排队中',
  preparing: '准备中',
  running: '运行中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
}[status] || status)

const statusTagType = (status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' => ({
  pending: 'info',
  preparing: 'warning',
  running: 'primary',
  completed: 'success',
  stopped: 'warning',
  failed: 'danger',
}[status] || 'info') as any

// ── 停止 / 删除 ──
const handleStop = async (row: any) => {
  stoppingId.value = row.id
  try {
    await request.post(`/backtest/runs/${row.id}/stop`, {}, { timeout: 90000 })
    ElMessage.success('停止请求已发送，等待引擎收尾')
    await fetchRuns()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '停止失败')
  } finally {
    stoppingId.value = null
  }
}

const handleDelete = async (row: any) => {
  try {
    await ElMessageBox.confirm(
      `删除回测 #${row.id} 将同时清理其导入的策略/订单/虚拟交易数据与运行文件，不可恢复。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await request.delete(`/backtest/runs/${row.id}`, { timeout: 90000 })
    ElMessage.success('回测已删除')
    if (detailRunId === row.id) {
      detailVisible.value = false
      detailRunId = null
    }
    await fetchRuns()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '删除失败')
  }
}

// ── 详情抽屉 ──
const detailVisible = ref(false)
const detailRun = ref<any>(null)
const reimporting = ref(false)
let chartInstance: echarts.ECharts | null = null

const monthRows = computed(() => {
  const byMonth = detailRun.value?.summary?.byMonth || {}
  return Object.entries(byMonth)
    .map(([month, v]: [string, any]) => ({ month, trades: v.trades, realizedPnl: Number(v.realizedPnl) }))
    .sort((a, b) => a.month.localeCompare(b.month))
})

const symbolRows = computed(() => {
  const bySymbol = detailRun.value?.summary?.bySymbol || {}
  return Object.entries(bySymbol)
    .map(([symbol, v]: [string, any]) => ({ symbol, trades: v.trades, realizedPnl: Number(v.realizedPnl) }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl)
})

const openDetail = (row: any) => {
  detailRunId = row.id
  detailRun.value = row
  detailVisible.value = true
  nextTick(() => renderEquityChart())
}

const renderEquityChart = () => {
  const container = document.getElementById('backtest-equity-chart')
  if (!container || !detailRun.value?.summary?.equityCurve) return

  if (chartInstance) {
    chartInstance.dispose()
    chartInstance = null
  }
  chartInstance = echarts.init(container)
  const points = detailRun.value.summary.equityCurve as Array<{ t: string; equity: number }>
  chartInstance.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
    xAxis: {
      type: 'category',
      data: points.map(p => p.t),
      axisLabel: { formatter: (v: string) => v?.slice(0, 10) },
    },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: (v: number) => v.toFixed(2) } },
    series: [
      {
        name: '权益',
        type: 'line',
        showSymbol: false,
        data: points.map(p => Number(p.equity.toFixed(4))),
        areaStyle: { opacity: 0.08 },
        lineStyle: { width: 2 },
      },
    ],
  })
}

const handleReimport = async () => {
  if (!detailRun.value) return
  reimporting.value = true
  try {
    await request.post(`/backtest/runs/${detailRun.value.id}/reimport`, {}, { timeout: 120000 })
    ElMessage.success('结果已重新导入主库')
    await fetchRuns()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '重新导入失败')
  } finally {
    reimporting.value = false
  }
}

// ── 生命周期 ──
onMounted(async () => {
  loading.value = true
  await Promise.all([fetchRoutes(), fetchRuns()])
  loading.value = false
  // 定时刷新：每 2s 轮询进度（运行中的回测与列表状态）
  pollTimer = setInterval(() => {
    void fetchRuns()
  }, 2000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  chartInstance?.dispose()
  chartInstance = null
})
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
}
.filter-header {
  display: flex;
  align-items: center;
}
.left-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.upload-tip {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-color-secondary, #909399);
  line-height: 1.6;
}
.upload-input :deep(.el-upload-list__item) {
  margin-top: 0;
}
.content-area {
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 16px;
}
.sub-text {
  font-size: 12px;
  color: var(--text-color-secondary, #909399);
  margin-top: 2px;
}
.text-success {
  color: var(--el-color-success);
}
.text-danger {
  color: var(--el-color-danger);
}
.detail-sections {
  margin-top: 8px;
}
.section-card {
  margin-bottom: 16px;
  background: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
}
.equity-chart {
  width: 100%;
  height: 320px;
}
.detail-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
</style>
