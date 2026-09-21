<template>
  <div class="logs-container">
    <div class="filter-header">
      <el-radio-group v-model="queryParams.source" @change="handleSourceChange">
          <el-radio-button label="normal">正常日志</el-radio-button>
          <el-radio-button label="error">错误日志</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="queryParams.traceId"
        placeholder="追踪 ID"
        style="width: 200px; margin-left: 12px"
        clearable
        @keyup.enter="handleSearch"
      />
      <el-input
        v-model="queryParams.keyword"
        placeholder="关键字搜索"
        clearable
        style="width: 200px; margin-left: 12px"
        @keyup.enter="handleSearch"
      />
      <el-select v-model="queryParams.level" placeholder="日志级别" clearable style="width: 120px; margin-left: 12px">
          <el-option label="INFO" value="info" />
          <el-option label="WARN" value="warn" />
          <el-option label="ERROR" value="error" />
      </el-select>
      <el-select v-model="queryParams.sort" placeholder="排序" style="width: 100px; margin-left: 12px" @change="handleSearch">
          <el-option label="最新" value="desc" />
          <el-option label="最早" value="asc" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="handleSearch" style="margin-left: 12px">查询</el-button>
      <el-button :icon="Refresh" @click="resetQuery">重置</el-button>
      <div style="flex: 1"></div>

      <el-radio-group v-model="viewMode" style="margin-right: 12px">
          <el-radio-button label="table">表格</el-radio-button>
          <el-radio-button label="text">文本</el-radio-button>
      </el-radio-group>

    </div>

    <div v-if="viewMode === 'table'">
        <el-table
        v-loading="loading"
        :data="logs"
        style="width: 100%; margin-top: 20px"
        border
        stripe
        >
        <el-table-column prop="timestamp" label="时间" width="180">
            <template #default="scope">
            {{ formatDate(scope.row.timestamp) }}
            </template>
        </el-table-column>
        <el-table-column prop="level" label="级别" width="110">
            <template #default="scope">
            <StatusBadge :value="scope.row.level" kind="level" />
            </template>
        </el-table-column>
        <el-table-column prop="traceId" label="追踪 ID" width="150">
            <template #default="scope">
                <el-tag v-if="scope.row.traceId" size="small" type="info" class="trace-tag" @click="filterByTraceId(scope.row.traceId)">
                    {{ scope.row.traceId }}
                </el-tag>
            </template>
        </el-table-column>
        <el-table-column prop="message" label="消息内容" min-width="300" show-overflow-tooltip>
            <template #default="scope">
                <span class="log-message">{{ scope.row.message }}</span>
            </template>
        </el-table-column>
        <el-table-column label="扩展字段" min-width="280" show-overflow-tooltip>
            <template #default="scope">
                <div v-if="getExtraEntries(scope.row).length > 0" class="extra-fields">
                    <span
                      v-for="[key, value] in getExtraEntries(scope.row)"
                      :key="key"
                      class="extra-field"
                    >
                      <span class="extra-key">{{ key }}=</span>{{ formatFieldValue(value) }}
                    </span>
                </div>
                <span v-else class="empty-extra">-</span>
            </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
            <template #default="scope">
            <el-button link type="primary" size="small" @click="viewDetails(scope.row)">详情</el-button>
            </template>
        </el-table-column>
        </el-table>
    </div>

    <div v-else class="text-view-container" v-loading="loading">
        <div
          v-for="(log, index) in logs"
          :key="index"
          class="log-line"
          :class="{ expanded: expandedLineIndex === index }"
          title="点击切换单行/换行显示"
          @click="toggleLineWrap(index)"
        >
            <span class="log-time">[{{ formatDate(log.timestamp) }}]</span>
            <span class="log-level" :class="log.level">[{{ log.level.toUpperCase() }}]</span>
            <span v-if="log.traceId" class="log-trace" @click.stop="filterByTraceId(log.traceId)">[{{ log.traceId }}]</span>
            <span class="log-msg">{{ log.message }}</span>
            <span
              v-for="[key, value] in getExtraEntries(log)"
              :key="key"
              class="log-extra"
            >
              <span class="log-extra-key">{{ key }}=</span>{{ formatFieldValue(value) }}
            </span>
        </div>
        <div v-if="logs.length === 0" class="no-data">暂无数据</div>
    </div>

    <div class="pagination-container">
      <el-pagination
        v-model:current-page="queryParams.page"
        v-model:page-size="queryParams.pageSize"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        @size-change="handleSizeChange"
        @current-change="handleCurrentChange"
      />
    </div>

    <!-- Details Dialog -->
    <LogDetailsDialog v-model="detailsVisible" :log="currentLog" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Search, Refresh } from '@element-plus/icons-vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { getExtraEntries, formatFieldValue } from '../utils/log'
import LogDetailsDialog from '../components/LogDetailsDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { formatDate } from '../utils/format'

interface LogEntry {
  timestamp: string
  level: string
  message: string
  traceId?: string
  [key: string]: any
}

const loading = ref(false)
const logs = ref<LogEntry[]>([])
const total = ref(0)
const detailsVisible = ref(false)
const currentLog = ref<LogEntry | null>(null)
const viewMode = ref('text')
const expandedLineIndex = ref<number | null>(null)

const queryParams = reactive({
  page: 1,
  pageSize: 100,
  traceId: '',
  keyword: '',
  level: '',
  sort: 'desc',
  source: 'normal'
})

const fetchLogs = async () => {
  loading.value = true
  expandedLineIndex.value = null
  try {
    const res = await request.get('/logs', {
      params: {
        page: queryParams.page,
        pageSize: queryParams.pageSize,
        traceId: queryParams.traceId || undefined,
        keyword: queryParams.keyword || undefined,
        level: queryParams.level || undefined,
        sort: queryParams.sort,
        source: queryParams.source
      }
    })
    logs.value = res.data.data || []
    total.value = res.data.total || 0
  } catch (error) {
    ElMessage.error('获取日志失败')
  } finally {
    loading.value = false
  }
}

const handleSearch = () => {
  queryParams.page = 1
  fetchLogs()
}

const resetQuery = () => {
  queryParams.traceId = ''
  queryParams.keyword = ''
  queryParams.level = ''
  queryParams.sort = 'desc'
  queryParams.source = 'normal'
  queryParams.page = 1
  fetchLogs()
}

const handleSourceChange = () => {
  queryParams.page = 1
  expandedLineIndex.value = null
  fetchLogs()
}

const handleSizeChange = (val: number) => {
  queryParams.pageSize = val
  fetchLogs()
}

const handleCurrentChange = (val: number) => {
  queryParams.page = val
  expandedLineIndex.value = null
  fetchLogs()
}

const viewDetails = (row: LogEntry) => {
  currentLog.value = row
  detailsVisible.value = true
}

const filterByTraceId = (traceId: string) => {
  queryParams.traceId = traceId
  handleSearch()
}

const toggleLineWrap = (index: number) => {
  expandedLineIndex.value = expandedLineIndex.value === index ? null : index
}

onMounted(() => {
  fetchLogs()
})
</script>

<style scoped>
.logs-container {
  padding: 20px;
  border-radius: 8px;
  min-height: calc(100vh - 100px);
}

.filter-header {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.trace-tag {
    cursor: pointer;
}
.trace-tag:hover {
    opacity: 0.8;
}

.extra-fields {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.extra-field {
    display: inline-block;
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #d4d4d4;
    background: rgba(144, 147, 153, 0.12);
    border: 1px solid rgba(144, 147, 153, 0.24);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: 'Fira Code', monospace;
    font-size: 12px;
}

.extra-key {
    color: #9cdcfe;
}

.empty-extra {
    color: #777;
}

.text-view-container {
    background-color: #1e1e1e;
    padding: 15px;
    border-radius: 4px;
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    line-height: 1.5;
    color: #d4d4d4;
    min-height: 400px;
    border: 1px solid #333;
    overflow-x: auto;
}

.log-line {
    padding: 2px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    display: flex;
    flex-wrap: nowrap;
    align-items: baseline;
    min-width: 100%;
    width: max-content;
    white-space: nowrap;
    cursor: pointer;
}

.log-line:hover {
    background-color: rgba(255, 255, 255, 0.05);
}

.log-line.expanded {
    flex-wrap: wrap;
    width: auto;
    white-space: normal;
}

.log-time {
    color: #569cd6;
    margin-right: 8px;
    white-space: nowrap;
}

.log-level {
    font-weight: bold;
    margin-right: 8px;
    min-width: 60px;
}

.log-level.info { color: #4ec9b0; }
.log-level.warn { color: #ce9178; }
.log-level.error { color: #f44747; }

.log-trace {
    color: #9cdcfe;
    margin-right: 8px;
    cursor: pointer;
}
.log-trace:hover {
    text-decoration: underline;
}

.log-msg {
    color: #d4d4d4;
    margin-right: 8px;
}

.log-line.expanded .log-msg,
.log-line.expanded .log-extra {
    word-break: break-all;
}

.log-extra {
    color: #ce9178;
    margin-right: 8px;
}

.log-extra-key {
    color: #9cdcfe;
}

.no-data {
    text-align: center;
    padding: 40px;
    color: #666;
}
</style>
