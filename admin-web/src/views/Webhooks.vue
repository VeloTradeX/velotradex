<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-button type="primary" :icon="Plus" @click="handleCreate">新建告警</el-button>
          <el-button :icon="Refresh" @click="fetchWebhooks">刷新</el-button>
        </div>
      </div>
    </el-card>

    <div class="content-area">
      <el-table :data="webhooks" v-loading="loading" style="width: 100%" class="data-table">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column prop="type" label="类型" width="120">
            <template #default="scope">
                <StatusBadge :value="scope.row.type" />
            </template>
        </el-table-column>
        <el-table-column prop="url" label="Webhook URL / 配置" show-overflow-tooltip>
            <template #default="scope">
                <span v-if="scope.row.type === 'webhook' || scope.row.type === 'feishu' || scope.row.type === 'dingtalk'">{{ scope.row.url }}</span>
                <span v-else-if="scope.row.type === 'pushover'">User: {{ getPushoverUser(scope.row) }}</span>
            </template>
        </el-table-column>
        <el-table-column prop="isActive" label="状态" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.isActive" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="订阅事件" show-overflow-tooltip>
            <template #default="scope">
                <span v-if="Array.isArray(scope.row.events)">
                    {{ scope.row.events.includes('*') ? '所有事件' : `${scope.row.events.length} 个事件` }}
                </span>
                <span v-else>{{ scope.row.events }}</span>
            </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="scope">
            <el-button size="small" @click="handleEdit(scope.row)">编辑</el-button>
            <el-button size="small" type="success" @click="handleTest(scope.row)">测试</el-button>
            <el-popconfirm title="确定删除吗?" @confirm="handleDelete(scope.row.id)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <WebhookFormDialog
      v-model="dialogVisible"
      ref="dialogRef"
      @saved="fetchWebhooks"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import request from '../utils/request'
import WebhookFormDialog from '../components/WebhookFormDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'

interface Webhook {
  id: number
  name: string
  type: string
  url: string
  method: string
  headers: string
  template: string
  config: string
  events: string[] | string
  isActive: boolean
}

const webhooks = ref<Webhook[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const dialogRef = ref<InstanceType<typeof WebhookFormDialog> | null>(null)

const getPushoverUser = (row: Webhook) => {
  try {
    const conf = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    return conf.userKey || '-'
  } catch (e) { return '-' }
}

const fetchWebhooks = async () => {
  loading.value = true
  try {
    const res = await request.get('/webhooks')
    webhooks.value = res.data.map((w: any) => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events,
      headers: typeof w.headers === 'object' ? JSON.stringify(w.headers, null, 2) : w.headers,
      config: typeof w.config === 'object' ? JSON.stringify(w.config, null, 2) : w.config
    }))
  } catch (error) {
    ElMessage.error('获取列表失败')
  } finally {
    loading.value = false
  }
}

const handleCreate = () => {
  dialogRef.value?.open()
}

const handleEdit = (row: Webhook) => {
  dialogRef.value?.open(row)
}

const handleDelete = async (id: number) => {
  try {
    await request.delete(`/webhooks/${id}`)
    ElMessage.success('删除成功')
    fetchWebhooks()
  } catch (error) {
    ElMessage.error('删除失败')
  }
}

const handleTest = async (row: Webhook) => {
  try {
    await request.post(`/webhooks/${row.id}/test`)
    ElMessage.success('测试发送成功')
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '测试发送失败')
  }
}

onMounted(() => {
  fetchWebhooks()
})
</script>

<style scoped>
.page-container {
  padding: 20px;
}
.filter-card {
  margin-bottom: 20px;
}
.filter-label {
  font-weight: bold;
  font-size: 16px;
}
.content-area {
  background: #fff;
  border-radius: 4px;
}
</style>
