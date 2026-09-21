<template>
  <div class="page-container">
    <el-card class="config-card">
      <div class="logs-header">
        <div class="logs-filters">
          <el-select
            v-model="filterRouteId"
            placeholder="信号路由"
            style="width: 220px;"
            clearable
            filterable
            @change="handleLogFilterChange"
            @clear="handleLogFilterChange"
          >
            <el-option
              v-for="route in signalRoutes"
              :key="route.id"
              :label="route.name"
              :value="String(route.id)"
            />
          </el-select>
          <el-tooltip content="刷新" placement="top">
            <el-button :icon="Refresh" circle @click="fetchLogs" :loading="logsLoading" />
          </el-tooltip>
          <el-button type="primary" :icon="Setting" @click="configDialogVisible = true">设置</el-button>
        </div>
      </div>
      <div class="logs-container">
        <el-table :data="logs" v-loading="logsLoading" style="width: 100%" stripe>
          <el-table-column prop="createdAt" label="时间" width="160">
            <template #default="scope">
              {{ formatDate(scope.row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column prop="model" label="模型" width="120" />
          <el-table-column label="信号路由" width="180" show-overflow-tooltip>
            <template #default="scope">
              {{ formatRouteNames(scope.row) }}
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="80">
            <template #default="scope">
              <el-tag :type="scope.row.status === 'success' ? 'success' : 'danger'">
                {{ scope.row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="durationMs" label="耗时" width="80">
            <template #default="scope">
              {{ formatDurationSec(scope.row.durationMs) }}s
            </template>
          </el-table-column>
          <el-table-column label="Token 消耗" width="110">
            <template #default="scope">
              <span v-if="scope.row.status === 'success'">
                {{ formatTokenCount(scope.row.totalTokens ?? (scope.row.promptTokens + scope.row.completionTokens)) }}
              </span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="关键动作" show-overflow-tooltip>
            <template #default="scope">
              {{ getResponseAction(scope.row) }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="scope">
              <el-button
                v-if="scope.row.status === 'error'"
                size="small"
                type="warning"
                :loading="isRetrying(scope.row.id)"
                @click="onTableRetry(scope.row)"
              >
                重试
              </el-button>
              <el-button size="small" @click="viewLogDetail(scope.row)">详情</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="pagination">
          <el-pagination
            background
            layout="prev, pager, next"
            :total="logsTotal"
            :page-size="logsLimit"
            v-model:current-page="logsPage"
            @current-change="fetchLogs"
          />
        </div>
      </div>
    </el-card>

    <!-- 配置表单对话框 -->
    <AIConfigFormDialog v-model="configDialogVisible" />

    <!-- 日志详情对话框 -->
    <AILogDetailDialog
      v-model="logDialogVisible"
      :log="currentLog"
      @retry="onDetailRetry"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { Refresh, Setting } from '@element-plus/icons-vue'
import { formatRouteNames, getResponseAction } from '../utils/aiLog'
import { useAiLogRetry } from '../composables/useAiLogRetry'
import AIConfigFormDialog from '../components/AIConfigFormDialog.vue'
import AILogDetailDialog from '../components/AILogDetailDialog.vue'
import { formatDate, formatTokenCount, formatDurationSec } from '../utils/format'

// 对话框显隐
const configDialogVisible = ref(false)
const logDialogVisible = ref(false)
const currentLog = ref<any>(null)

// 日志列表数据
const logs = ref<any[]>([])
const logsLoading = ref(false)
const logsTotal = ref(0)
const logsPage = ref(1)
const logsLimit = ref(20)
const signalRoutes = ref<any[]>([])
const filterRouteId = ref('')

const fetchLogs = async () => {
  logsLoading.value = true
  try {
    const res = await request.get('/ai-config/logs', {
      params: {
        page: logsPage.value,
        limit: logsLimit.value,
        ...(filterRouteId.value ? { routeId: filterRouteId.value } : {})
      }
    })
    logs.value = res.data.logs
    logsTotal.value = res.data.total
  } catch (e) {
    ElMessage.error('获取日志失败')
  } finally {
    logsLoading.value = false
  }
}

const fetchRoutes = async () => {
  try {
    const res = await request.get('/routes')
    signalRoutes.value = res.data
  } catch {
    ElMessage.error('获取信号路由失败')
  }
}

const handleLogFilterChange = () => {
  logsPage.value = 1
  fetchLogs()
}

const viewLogDetail = async (log: any) => {
  // 先展示部分数据，再异步拉取完整日志（含图片等详情）
  currentLog.value = log
  logDialogVisible.value = true
  try {
    const res = await request.get(`/ai-config/logs/${log.id}`)
    // 仅当当前仍处于该日志详情时合并完整数据
    if (currentLog.value && currentLog.value.id === log.id) {
      currentLog.value = res.data
    }
  } catch (e) {
    // 拉取失败时回退到部分数据
  }
}

// 重试逻辑（表格行内「重试」与详情弹窗内「重新解析」共用同一份 loading 状态）
const { isRetrying, retryLog } = useAiLogRetry(fetchLogs)

const onTableRetry = async (row: any) => {
  const res = await retryLog(row)
  // 重试成功且返回新日志时，打开详情弹窗展示解析结果
  if (res?.log) {
    currentLog.value = res.log
    logDialogVisible.value = true
  }
}

const onDetailRetry = async (triggerOrder: boolean) => {
  if (!currentLog.value) return
  const res = await retryLog(currentLog.value, triggerOrder)
  // 重试成功且返回新日志时，刷新弹窗内展示的日志
  if (res?.log) {
    currentLog.value = res.log
  }
}

onMounted(() => {
  fetchRoutes()
  fetchLogs()
})
</script>

<style scoped>
.page-container {
  padding: 20px;
}
.config-card {
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
.logs-header {
  display: flex;
  justify-content: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.logs-filters {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}
</style>
