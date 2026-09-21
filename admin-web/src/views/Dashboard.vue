<template>
  <div class="page-container">
    <!-- ============ 系统状态总览 ============ -->
    <h2 class="page-section-title">系统状态</h2>

    <div class="content-area" style="margin-top: 16px;">
        <!-- 总体状态 -->
        <el-alert
            :type="overallType"
            :closable="false"
            show-icon
            style="margin-bottom: 8px;"
        >
            <template #title>{{ overallTitle }}</template>
            <div v-if="issues.length && !alertCollapsed" class="issue-list">
                <div v-for="(issue, i) in issues" :key="i" class="issue-item" :class="`issue-item--${issue.level}`">
                    <el-icon :size="13"><Warning v-if="issue.level === 'warning'" /><CircleClose v-else /></el-icon>
                    <span>{{ issue.text }}</span>
                </div>
            </div>
        </el-alert>

        <div v-if="issues.length" style="margin-bottom: 16px; text-align: right;">
            <el-button link type="primary" size="small" @click="alertCollapsed = !alertCollapsed">
                {{ alertCollapsed ? '展开详情' : '收起详情' }}
            </el-button>
        </div>
        <div v-else style="margin-bottom: 16px;"></div>

        <!-- 组件状态卡片 -->
        <div class="status-grid">
            <div class="status-card" :class="statusCardClass(redisOk, true)">
                <div class="status-card__title">
                    <el-icon :size="16"><Coin /></el-icon>
                    Redis
                    <StatusBadge :value="redisOk" size="small" :label="redisOk ? '已连接' : '未连接'" />
                </div>
                <div class="status-card__detail" v-if="redisOk !== null">
                    <template v-if="redisOk">
                        sub: {{ status.redis?.subStatus }} / pub: {{ status.redis?.pubStatus }}
                    </template>
                    <template v-else>
                        sub: {{ status.redis?.subStatus }} / pub: {{ status.redis?.pubStatus }}
                        <div v-if="status.redis?.lastError" class="status-card__error" :title="status.redis.lastError">
                            {{ truncate(status.redis.lastError, 40) }}
                        </div>
                    </template>
                </div>
                <div class="status-card__detail" v-else>检测中…</div>
            </div>

            <div class="status-card" :class="statusCardClass(dbOk, false)">
                <div class="status-card__title">
                    <el-icon :size="16"><DataBoard /></el-icon>
                    数据库
                    <StatusBadge :value="dbOk" size="small" :label="dbLabel" />
                </div>
                <div class="status-card__detail" v-if="dbOk === null">检测中…</div>
                <div class="status-card__detail" v-else-if="dbOk">SQLite 连接正常</div>
                <div class="status-card__detail status-card__error" v-else>数据库连接异常</div>
            </div>

            <div class="status-card" :class="statusCardClass(wsOk, false)">
                <div class="status-card__title">
                    <el-icon :size="16"><Connection /></el-icon>
                    交易所 WS
                    <span class="status-pill" :class="wsOk === null ? 'pill-neutral' : wsOk ? 'pill-ok' : 'pill-fail'">
                        <el-icon :size="12" v-if="wsOk !== null"><CircleCheck v-if="wsOk" /><CircleClose v-else /></el-icon>
                        <span>{{ wsLabel }}</span>
                    </span>
                </div>
                <div class="status-card__detail" v-if="wsOk === null">无交易所实例</div>
                <div class="status-card__detail" v-else-if="wsOk">全部已连接</div>
                <div class="status-card__detail status-card__error" v-else>
                    {{ wsDownCount }} 个交易所连接断开
                </div>
            </div>

            <div class="status-card" :class="statusCardClass(restOk, false)">
                <div class="status-card__title">
                    <el-icon :size="16"><Odometer /></el-icon>
                    交易所 REST
                    <span class="status-pill" :class="restOk === null ? 'pill-neutral' : restOk ? 'pill-ok' : 'pill-fail'">
                        <el-icon :size="12" v-if="restOk !== null"><CircleCheck v-if="restOk" /><CircleClose v-else /></el-icon>
                        <span>{{ restLabel }}</span>
                    </span>
                </div>
                <div class="status-card__detail" v-if="restOk === null">无实例或未探测</div>
                <div class="status-card__detail" v-else-if="restOk">行情接口正常</div>
                <div class="status-card__detail status-card__error" v-else>行情接口请求失败</div>
            </div>
        </div>

        <div class="status-footer">
            <span class="refresh-time">上次刷新：{{ lastUpdatedText }}</span>
            <el-button size="small" :icon="Refresh" @click="manualRefresh" :loading="statusLoading">立即刷新</el-button>
        </div>
    </div>

    <!-- ============ 交易所实例监控 ============ -->
    <h2 class="page-section-title">交易所实例监控</h2>

    <div v-if="loading && !exchanges.length" style="text-align: center; padding: 50px;">
        <el-skeleton :rows="5" animated />
    </div>

    <div v-else class="content-area">
        <div class="table-toolbar">
            <el-button
                v-if="isAdmin"
                size="small"
                type="danger"
                plain
                :icon="Delete"
                :loading="clearingErrors"
                @click="clearAllErrors"
            >清空错误次数</el-button>
        </div>
        <el-table :data="exchanges" style="width: 100%" stripe border class="data-table">
            <el-table-column prop="id" label="ID" width="150" />
            <el-table-column prop="name" label="名称" width="150" />
            <el-table-column prop="type" label="类型" width="160">
                <template #default="scope">
                    <div class="cell-with-logo">
                        <ExchangeLogo :type="scope.row.type" size="sm" />
                        <StatusBadge :value="scope.row.type" />
                    </div>
                </template>
            </el-table-column>

            <el-table-column label="状态" width="100">
                <template #default="scope">
                    <StatusBadge :value="scope.row.status" kind="status" />
                </template>
            </el-table-column>

            <el-table-column label="可用余额" min-width="150">
                <template #default="scope">
                    <span v-if="scope.row.balance" class="success-text">
                        {{ formatFixed(scope.row.balance.available) }} {{ scope.row.balance.currency }}
                    </span>
                    <span v-else>-</span>
                </template>
            </el-table-column>

            <el-table-column label="总资产" min-width="150">
                <template #default="scope">
                    <span v-if="scope.row.balance">
                        {{ formatFixed(scope.row.balance.total) }} {{ scope.row.balance.currency }}
                    </span>
                    <span v-else>-</span>
                </template>
            </el-table-column>

            <el-table-column label="WS 连接" width="130">
                <template #default="scope">
                    <span v-if="scope.row.stats" class="status-pill" :class="scope.row.stats.isConnected ? 'pill-ok' : 'pill-fail'">
                        <el-icon :size="12"><CircleCheck v-if="scope.row.stats.isConnected" /><CircleClose v-else /></el-icon>
                        <span>{{ scope.row.stats.isConnected ? '已连接' : '已断开' }}</span>
                    </span>
                    <span v-else>-</span>
                </template>
            </el-table-column>

            <el-table-column label="REST 健康" width="130">
                <template #default="scope">
                    <span v-if="scope.row.restOk !== null && scope.row.restOk !== undefined" class="status-pill" :class="scope.row.restOk ? 'pill-ok' : 'pill-fail'">
                        <el-icon :size="12"><CircleCheck v-if="scope.row.restOk" /><CircleClose v-else /></el-icon>
                        <span>{{ scope.row.restOk ? '正常' : '异常' }}</span>
                    </span>
                    <span v-else>-</span>
                </template>
            </el-table-column>

            <el-table-column label="错误次数" width="120">
                <template #default="scope">
                    <el-tag :type="scope.row.errorCount > 0 ? 'danger' : 'info'" size="small">
                        {{ scope.row.errorCount || 0 }}
                    </el-tag>
                    <el-button link type="primary" size="small" style="margin-left: 4px;" @click="openConnectionLogs(scope.row)">
                        查看
                    </el-button>
                    <el-button v-if="isAdmin && scope.row.errorCount > 0" link type="danger" size="small" style="margin-left: 4px;" @click="clearExchangeErrors(scope.row)">
                        清空
                    </el-button>
                </template>
            </el-table-column>

            <el-table-column label="WS 统计" min-width="200">
                <template #default="scope">
                    <div v-if="scope.row.stats" style="font-size: 12px;">
                        <div>重连: {{ scope.row.stats.reconnectCount }} | 心跳: {{ scope.row.stats.heartbeatCount }}</div>
                        <div v-if="scope.row.stats.connectedAt" style="color: #999;">
                            Since: {{ formatDate(scope.row.stats.connectedAt) }}
                        </div>
                    </div>
                    <span v-else>-</span>
                </template>
            </el-table-column>

            <el-table-column label="最近错误" min-width="200">
                <template #default="scope">
                     <span v-if="scope.row.stats && scope.row.stats.lastError" class="error-text" :title="scope.row.stats.lastError">
                        {{ truncate(scope.row.stats.lastError, 30) }}
                     </span>
                     <span v-else-if="scope.row.restError" class="error-text" :title="scope.row.restError">
                        {{ truncate(scope.row.restError, 30) }}
                     </span>
                </template>
            </el-table-column>
        </el-table>
    </div>

    <h2 class="page-section-title">交易模式</h2>

    <div class="content-area" style="margin-top: 16px;">
        <el-descriptions :column="2" border>
            <el-descriptions-item label="当前模式">
                <el-tag :type="tradingModeType">{{ tradingModeText }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="交易状态">
                <el-tag :type="tradingConfig.enableTrading ? 'success' : 'warning'">
                    {{ tradingConfig.enableTrading ? '已启用' : '已禁用' }}
                </el-tag>
            </el-descriptions-item>
        </el-descriptions>
    </div>

    <!-- Version Information -->
    <div v-if="version" class="version-info" style="margin-top: 40px; text-align: right; color: var(--text-color-secondary); font-size: 12px;">
        Version: {{ version }}
    </div>

    <!-- 连接错误记录详情 -->
    <el-dialog v-model="logDialogVisible" :title="`连接错误记录 - ${currentExchange?.name || ''}`" width="820px">
        <el-table v-if="connectionLogs.length" :data="connectionLogs" stripe border size="small" style="width: 100%" class="data-table">
            <el-table-column label="断开时间" min-width="150">
                <template #default="scope">{{ formatDate(scope.row.disconnectedAt) }}</template>
            </el-table-column>
            <el-table-column label="重连时间" min-width="150">
                <template #default="scope">
                    <span v-if="scope.row.reconnectedAt">{{ formatDate(scope.row.reconnectedAt) }}</span>
                    <el-tag v-else type="danger" size="small">断线中</el-tag>
                </template>
            </el-table-column>
            <el-table-column label="持续时间" width="110">
                <template #default="scope">{{ formatDuration(scope.row.durationMs) }}</template>
            </el-table-column>
            <el-table-column label="原因" min-width="220">
                <template #default="scope">
                    <span :title="scope.row.reason || ''">{{ truncate(scope.row.reason || '-', 40) }}</span>
                </template>
            </el-table-column>
        </el-table>
        <div v-else style="text-align: center; color: var(--text-color-secondary); padding: 24px 0;">
            暂无连接错误记录
        </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import request from '../utils/request'
import { formatFixed, formatDate } from '../utils/format'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { Coin, DataBoard, Connection, Odometer, Warning, CircleClose, CircleCheck, Refresh, Delete } from '@element-plus/icons-vue'

// Configure axios base url if needed, or rely on vite proxy
const api = request

const authStore = useAuthStore()
const isAdmin = computed(() => authStore.user?.role === 'admin')

const exchanges = ref<any[]>([])
const loading = ref(false)
const tradingConfig = ref({ mode: 'observe', enableTrading: false })
const version = ref('')

// ---- 系统状态 ----
const status = ref<any>({ overall: 'ok', redis: {}, database: {}, exchanges: [] })
const lastUpdated = ref<number>(0)
const statusLoading = ref(false)
const alertCollapsed = ref(true)
let timer: any = null

const tradingModeText = computed(() => {
    const modeMap: Record<string, string> = {
        'real': '实盘',
        'testnet': '测试网',
        'observe': '观察模式'
    }
    return modeMap[tradingConfig.value.mode] || tradingConfig.value.mode
})

const tradingModeType = computed(() => {
    const typeMap: Record<string, string> = {
        'real': 'danger',
        'testnet': 'warning',
        'observe': 'info'
    }
    return typeMap[tradingConfig.value.mode] || 'info'
})

const truncate = (str: string, len: number) => {
    if (!str) return ''
    return str.length > len ? str.substring(0, len) + '...' : str
}

// ---- 连接错误记录 ----
const logDialogVisible = ref(false)
const currentExchange = ref<any>(null)
const connectionLogs = ref<any[]>([])

const openConnectionLogs = async (row: any) => {
    currentExchange.value = row
    connectionLogs.value = []
    logDialogVisible.value = true
    try {
        const res = await api.get(`/exchanges/${row.id}/connection-logs?limit=20`)
        connectionLogs.value = res.data || []
    } catch (error) {
        console.error('Failed to fetch connection logs', error)
    }
}

const formatDuration = (ms: number | string | null | undefined): string => {
    if (ms === null || ms === undefined || ms === '') return '-'
    const total = Number(ms) / 1000
    if (!Number.isFinite(total)) return '-'
    if (total < 60) return `${Math.round(total)}s`
    const m = Math.floor(total / 60)
    const rs = Math.floor(total % 60)
    if (m < 60) return `${m}m ${rs}s`
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m ${rs}s`
}

// ---- 清空错误次数 ----
const clearingErrors = ref(false)

const clearAllErrors = async () => {
    try {
        await ElMessageBox.confirm(
            '确定清空所有交易所的错误次数记录？该操作不可恢复。',
            '清空错误次数',
            { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
        )
    } catch {
        return // 用户取消
    }
    clearingErrors.value = true
    try {
        const res = await api.delete('/exchanges/connection-logs')
        ElMessage.success(`已清空 ${res.data?.deleted ?? 0} 条错误记录`)
        await fetchData()
    } catch (e: any) {
        ElMessage.error(e?.response?.data?.error || '清空失败')
    } finally {
        clearingErrors.value = false
    }
}

const clearExchangeErrors = async (row: any) => {
    try {
        await ElMessageBox.confirm(
            `确定清空「${row.name || row.id}」的错误次数记录？该操作不可恢复。`,
            '清空错误次数',
            { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
        )
    } catch {
        return
    }
    try {
        const res = await api.delete(`/exchanges/${row.id}/connection-logs`)
        ElMessage.success(`已清空 ${res.data?.deleted ?? 0} 条错误记录`)
        await fetchData()
    } catch (e: any) {
        ElMessage.error(e?.response?.data?.error || '清空失败')
    }
}

// ---- 系统状态派生 ----
const redisOk = computed<boolean | null>(() => {
    const v = status.value?.redis
    if (!v) return null
    return !!v.ready
})

const dbOk = computed<boolean | null>(() => {
    const v = status.value?.database
    if (!v) return null
    return v.ok
})

const wsOk = computed<boolean | null>(() => {
    const list = status.value?.exchanges || []
    if (!list.length) return null
    return list.every((e: any) => e.wsConnected)
})

const wsDownCount = computed(() => {
    const list = status.value?.exchanges || []
    return list.filter((e: any) => !e.wsConnected).length
})

const restOk = computed<boolean | null>(() => {
    const list = status.value?.exchanges || []
    const probed = list.filter((e: any) => e.restOk !== null && e.restOk !== undefined)
    if (!probed.length) return null
    return probed.every((e: any) => e.restOk)
})

const dbLabel = computed(() => {
    if (dbOk.value === true) return '正常'
    if (dbOk.value === false) return '异常'
    return '检测中'
})

const wsLabel = computed(() => {
    if (wsOk.value === null) return '无实例'
    return wsOk.value ? '已连接' : '断开'
})

const restLabel = computed(() => {
    if (restOk.value === null) return '未探测'
    return restOk.value ? '正常' : '异常'
})

const overallType = computed(() => {
    if (status.value?.overall === 'critical') return 'error'
    if (status.value?.overall === 'degraded') return 'warning'
    return 'success'
})

const overallTitle = computed(() => {
    if (status.value?.overall === 'critical') return '系统严重异常：数据库不可用'
    if (status.value?.overall === 'degraded') return '系统降级运行：部分组件异常，其他 API 不受影响'
    return '所有系统组件运行正常'
})

const issues = computed(() => {
    const list: Array<{ level: 'error' | 'warning', text: string }> = []
    const s = status.value || {}

    if (s.redis && !s.redis.ready) {
        let text = `Redis 未连接（sub:${s.redis.subStatus} / pub:${s.redis.pubStatus}）`
        if (s.redis.lastError) text += `：${s.redis.lastError}`
        list.push({ level: 'error', text })
    }

    if (s.database) {
        if (s.database.ok === false) {
            list.push({ level: 'error', text: '数据库连接异常，请检查 SQLite 数据库文件' })
        } else if (s.database.ok === null) {
            list.push({ level: 'warning', text: '数据库状态检测中…' })
        }
    }

    for (const ex of s.exchanges || []) {
        if (!ex.registered) {
            list.push({ level: 'error', text: `交易所 ${ex.name}（${ex.id}）未成功加载，请检查配置或系统日志` })
        } else if (!ex.wsConnected) {
            let text = `交易所 ${ex.name}（${ex.id}）WS 连接断开`
            if (ex.wsStats?.lastError) text += `：${ex.wsStats.lastError}`
            text += `（重连 ${ex.wsStats?.reconnectCount || 0} 次）`
            list.push({ level: 'error', text })
        }
        if (ex.restOk === false) {
            list.push({ level: 'error', text: `交易所 ${ex.name}（${ex.id}）行情接口请求失败：${ex.lastRESTError || '未知错误'}` })
        }
    }

    return list
})

const lastUpdatedText = computed(() => {
    if (!lastUpdated.value) return '尚未刷新'
    return new Date(lastUpdated.value).toLocaleTimeString()
})

function statusCardClass(ok: boolean | null, allowUnknownAsOk: boolean): string {
    if (ok === null) return allowUnknownAsOk ? 'status-card--ok' : 'status-card--pending'
    return ok ? 'status-card--ok' : 'status-card--error'
}

// ---- 数据拉取 ----
const fetchVersion = async () => {
    try {
        const res = await api.get('/version')
        version.value = res.data.version || ''
    } catch (error) {
        // Silently fail if version API is not available
        version.value = ''
    }
}

const fetchTradingConfig = async () => {
    try {
        const res = await api.get('/config/trading-mode')
        tradingConfig.value = res.data
    } catch (error) {
        console.error('Failed to fetch trading config', error)
    }
}

const fetchStatus = async () => {
    statusLoading.value = true
    try {
        const res = await api.get('/status')
        status.value = res.data
        lastUpdated.value = Date.now()
    } catch (error) {
        console.error('Failed to fetch system status', error)
    } finally {
        statusLoading.value = false
    }
}

const manualRefresh = async () => {
    await Promise.all([fetchStatus(), fetchData(), fetchTradingConfig()])
}

const fetchData = async () => {
    try {
        const res = await api.get('/exchanges')
        // Expected format: array of ExchangeInstance with merged stats
        const list = res.data

        // Fetch balance for each exchange
        await Promise.all(list.map(async (ex: any) => {
            try {
                // Only fetch if active or has ID (test connection handled elsewhere)
                if (ex.status === 'active') {
                    const balRes = await api.get(`/exchanges/${ex.id}/balance`)
                    ex.balance = balRes.data
                }
            } catch (e: any) {
                // 余额获取失败时保留已有数据并在表格中体现（后端会返回 exchangeConnected 等错误信息）
                if (!ex.balance) {
                    ex.balance = null
                }
            }
        }))

        exchanges.value = list
    } catch (error) {
        console.error('Failed to fetch exchanges', error)
    } finally {
        loading.value = false
    }
}

onMounted(() => {
    loading.value = true
    fetchData()
    fetchTradingConfig()
    fetchVersion()
    fetchStatus()
    timer = setInterval(() => {
        fetchData()
        fetchTradingConfig()
        fetchStatus()
    }, 5000)
})

onUnmounted(() => {
    if (timer) clearInterval(timer)
})
</script>

<style scoped>
.success-text {
  color: var(--color-success);
  font-weight: bold;
}

.cell-with-logo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.error-text {
    color: var(--color-danger);
    font-size: 12px;
}

/* ---- 系统状态面板 ---- */
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.status-card {
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 12px 14px;
  background-color: var(--bg-color);
}

.status-card--ok {
  border-color: color-mix(in srgb, var(--color-success) 30%, transparent);
  background-color: color-mix(in srgb, var(--color-success) 5%, transparent);
}

.status-card--error {
  border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
  background-color: color-mix(in srgb, var(--color-danger) 5%, transparent);
}

.status-card--pending {
  border-color: color-mix(in srgb, var(--el-color-info) 30%, transparent);
  background-color: color-mix(in srgb, var(--el-color-info) 5%, transparent);
}

.status-card__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
}

.status-card__title .status-badge {
  margin-left: auto;
}

.status-card__detail {
  font-size: 12px;
  color: var(--text-color-secondary);
  line-height: 1.5;
}

.status-card__error {
  color: var(--color-danger);
}

.issue-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.issue-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}

.issue-item--error {
  color: var(--color-danger);
}

.issue-item--warning {
  color: var(--el-color-warning);
}

.status-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.refresh-time {
  font-size: 12px;
  color: var(--text-color-secondary);
}

.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}

/* 交易所表格中的状态胶囊（与 StatusBadge 解耦，强制区分正常/异常色调） */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
  border: 1px solid transparent;
}

.status-pill.pill-ok {
  color: var(--color-success, var(--el-color-success));
  background-color: color-mix(in srgb, var(--color-success, var(--el-color-success)) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-success, var(--el-color-success)) 30%, transparent);
}

.status-pill.pill-fail {
  color: var(--color-danger, var(--el-color-danger));
  background-color: color-mix(in srgb, var(--color-danger, var(--el-color-danger)) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-danger, var(--el-color-danger)) 30%, transparent);
}

.status-pill.pill-neutral {
  color: var(--el-color-info);
  background-color: color-mix(in srgb, var(--el-color-info) 12%, transparent);
  border-color: color-mix(in srgb, var(--el-color-info) 30%, transparent);
}

.status-pill .el-icon {
  display: inline-flex;
}
</style>
