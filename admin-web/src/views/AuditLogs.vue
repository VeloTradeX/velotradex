<template>
  <div class="page-container">
    <!-- Filters -->
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-input v-model="filters.userId" placeholder="用户ID" clearable style="width: 120px" />
          <el-select v-model="filters.method" placeholder="请求方法" clearable style="width: 100px">
            <el-option label="GET" value="GET" />
            <el-option label="POST" value="POST" />
            <el-option label="PUT" value="PUT" />
            <el-option label="DELETE" value="DELETE" />
          </el-select>
          <el-input v-model="filters.path" placeholder="路径 (/api/...)" clearable style="width: 180px" />
          <el-date-picker
            v-model="filters.dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 320px"
          />
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </div>
      </div>
    </el-card>

    <!-- Table -->
    <div class="content-area">
      <el-table :data="logs" v-loading="loading" style="width: 100%" class="data-table">
        <el-table-column type="expand">
          <template #default="props">
            <div style="padding: 20px;">
              <p><strong>参数:</strong></p>
              <pre class="params-pre">{{ formatJson(props.row.params) }}</pre>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="用户" width="120">
          <template #default="scope">
            {{ scope.row.username || `ID:${scope.row.userId}` || 'System' }}
          </template>
        </el-table-column>
        <el-table-column prop="method" label="方法" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.method" kind="method" />
          </template>
        </el-table-column>
        <el-table-column prop="path" label="路径" show-overflow-tooltip />
        <el-table-column prop="statusCode" label="状态码" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.statusCode" kind="http" />
          </template>
        </el-table-column>
        <el-table-column prop="duration" label="耗时(ms)" width="100" />
        <el-table-column prop="ip" label="IP 地址" width="140" />
        <el-table-column prop="createdAt" label="时间" width="180">
          <template #default="scope">
            {{ formatDate(scope.row.createdAt) }}
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination -->
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.limit"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          :total="pagination.total"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { formatDate } from '../utils/format'
import { Search, Refresh } from '@element-plus/icons-vue'
import StatusBadge from '../components/StatusBadge.vue'

const logs = ref([])
const loading = ref(false)

const filters = reactive({
  userId: '',
  method: '',
  path: '',
  dateRange: [] as string[]
})

const pagination = reactive({
  page: 1,
  limit: 20,
  total: 0
})

const formatJson = (jsonStr: string) => {
  try {
    const obj = JSON.parse(jsonStr)
    return JSON.stringify(obj, null, 2)
  } catch (e) {
    return jsonStr
  }
}

const fetchLogs = async () => {
  loading.value = true
  try {
    const params: any = {
      page: pagination.page,
      limit: pagination.limit,
      userId: filters.userId || undefined,
      method: filters.method || undefined,
      path: filters.path || undefined
    }

    if (filters.dateRange && filters.dateRange.length === 2) {
      params.startDate = filters.dateRange[0]
      params.endDate = filters.dateRange[1]
    }

    const res = await request.get('/audit-logs', { params })
    logs.value = res.data.data
    pagination.total = res.data.total
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '获取日志失败')
  } finally {
    loading.value = false
  }
}

const handleSearch = () => {
  pagination.page = 1
  fetchLogs()
}

const handleReset = () => {
  filters.userId = ''
  filters.method = ''
  filters.path = ''
  filters.dateRange = []
  handleSearch()
}

const handleSizeChange = (val: number) => {
  pagination.limit = val
  fetchLogs()
}

const handleCurrentChange = (val: number) => {
  pagination.page = val
  fetchLogs()
}

onMounted(() => {
  fetchLogs()
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

.content-area {
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 20px;
}

.data-table {
  background-color: transparent;
}

.params-pre {
  background-color: var(--bg-color-base);
  color: var(--text-color-primary);
  border: 1px solid var(--border-color-base);
  padding: 10px;
  border-radius: 4px;
  overflow-x: auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}
</style>
