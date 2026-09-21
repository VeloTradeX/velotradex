<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <template v-if="!backtestRunId">
            <span class="filter-label">信号路由:</span>
            <el-select v-model="selectedRouteId" placeholder="全局 (Global)" clearable style="width: 240px;">
              <el-option label="全局 (Global)" :value="undefined" />
              <el-option
                  v-for="route in routes"
                  :key="route.id"
                  :label="`${route.name} (${route.channelId})`"
                  :value="route.id"
              />
            </el-select>

            <span class="filter-label" style="margin-left: 20px;">时间范围:</span>
            <el-radio-group v-model="selectedDays" size="default">
              <el-radio-button :label="7">最近 7 天</el-radio-button>
              <el-radio-button :label="30">最近 30 天</el-radio-button>
              <el-radio-button :label="90">最近 90 天</el-radio-button>
              <el-radio-button :label="180">最近 180 天</el-radio-button>
            </el-radio-group>
          </template>
          <template v-else>
            <el-tag type="warning" effect="dark" size="large" closable @close="exitBacktestMode">
              回测模式 #{{ backtestRunId }}：{{ backtestRun?.name || backtestRun?.runKey || '' }}
            </el-tag>
            <span class="filter-label backtest-hint">统计范围为该次回测的全部订单（按 K 线触发时间聚合）</span>
            <el-button size="small" @click="router.push('/backtest')">返回回测列表</el-button>
          </template>
        </div>
      </div>
    </el-card>

    <div class="content-area">
      <TradingStats
        :days="selectedDays"
        :route-id="selectedRouteId"
        :backtest-run-id="backtestRunId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import request from '../utils/request'
import TradingStats from '../components/TradingStats.vue'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()

const routes = ref<any[]>([])
const selectedRouteId = ref<number | undefined>(undefined)
const selectedDays = ref(30)

// 回测模式：/statistics?backtestRunId=X（来自回测页跳转）
const backtestRunId = ref<number | undefined>(undefined)
const backtestRun = ref<any>(null)

const loadBacktestMode = async () => {
  const raw = route.query.backtestRunId
  const id = Number(Array.isArray(raw) ? raw[0] : raw)
  if (Number.isFinite(id) && id > 0) {
    backtestRunId.value = id
    try {
      const res = await request.get(`/backtest/runs/${id}`)
      backtestRun.value = res.data
    } catch {
      /* 名称展示尽力而为 */
    }
  }
}

const exitBacktestMode = () => {
  backtestRunId.value = undefined
  backtestRun.value = null
  router.replace({ path: '/statistics' })
}

const fetchRoutes = async () => {
  try {
    const res = await request.get('/routes')
    routes.value = res.data
  } catch (e: any) {
    ElMessage.error('获取路由列表失败')
  }
}

onMounted(() => {
  loadBacktestMode()
  fetchRoutes()
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
}
.left-panel {
  display: flex;
  align-items: center;
  gap: 12px;
}
.filter-label {
  font-size: 14px;
  color: var(--text-color-primary);
  margin-right: 10px;
}
.backtest-hint {
  margin-right: 0;
  color: var(--text-color-secondary, #909399);
}
.content-area {
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 20px;
}
</style>
