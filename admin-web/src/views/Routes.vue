<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <div class="left-panel">
          <el-button :icon="Refresh" @click="fetchData" :loading="loading">刷新</el-button>
          <el-button type="primary" :icon="Plus" @click="handleAdd">添加路由</el-button>
        </div>
      </div>
    </el-card>

    <div class="content-area">
      <el-table :data="routes" v-loading="loading" style="width: 100%" class="data-table">
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="channelId" label="频道 ID" width="180" />
        <el-table-column prop="exchangeInstanceId" label="交易所" width="240">
           <template #default="scope">
              <div v-if="getExchange(scope.row.exchangeInstanceId)" class="cell-with-logo">
                <ExchangeLogo :type="getExchange(scope.row.exchangeInstanceId).type" size="sm" />
                <span>{{ getExchangeName(scope.row.exchangeInstanceId) }}</span>
              </div>
              <span v-else>{{ scope.row.exchangeInstanceId }}</span>
           </template>
        </el-table-column>
        <el-table-column prop="parser" label="解析器" width="150">
           <template #default="scope">
              {{ scope.row.parser || 'Default' }}
           </template>
        </el-table-column>
        <el-table-column prop="aiMode" label="AI 模式" width="120">
           <template #default="scope">
              <StatusBadge :value="scope.row.aiMode" kind="mode" />
           </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
           <template #default="scope">
              <el-switch v-model="scope.row.isActive" @change="handleStatusChange(scope.row)" />
           </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="scope">
            <el-button size="small" @click="showDetails(scope.row)">详情</el-button>
            <el-button size="small" @click="handleEdit(scope.row)">编辑</el-button>
            <el-popconfirm title="确定删除吗？" @confirm="handleDelete(scope.row.id)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 编辑/新增 路由对话框 -->
    <RouteEditDialog
      v-model="dialogVisible"
      :editing-route="editingRoute"
      :exchanges="exchanges"
      :parsers="parsers"
      @saved="fetchData"
    />

    <!-- 路由详情对话框 -->
    <RouteDetailsDialog
      v-model="detailsVisible"
      :route="selectedRoute"
      :exchanges="exchanges"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import request from '../utils/request'
import RouteEditDialog from '../components/RouteEditDialog.vue'
import RouteDetailsDialog from '../components/RouteDetailsDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

const routes = ref<any[]>([])
const exchanges = ref<any[]>([])
const parsers = ref<any[]>([])
const loading = ref(false)

// 编辑/新增对话框
const dialogVisible = ref(false)
const editingRoute = ref<any | null>(null)

// 详情对话框
const detailsVisible = ref(false)
const selectedRoute = ref<any | null>(null)

const fetchData = async () => {
  loading.value = true
  try {
    const [routesRes, exchangesRes, parsersRes] = await Promise.all([
      request.get('/routes'),
      request.get('/exchanges'),
      request.get('/parsers')
    ])
    routes.value = routesRes.data
    exchanges.value = exchangesRes.data
    parsers.value = parsersRes.data
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

const getExchange = (id: string) => {
  return exchanges.value.find(e => e.id === id)
}

const getExchangeName = (id: string) => {
  const ex = getExchange(id)
  return ex ? `${ex.name} (${id})` : id
}

const handleAdd = () => {
  editingRoute.value = null
  dialogVisible.value = true
}

const handleEdit = (row: any) => {
  editingRoute.value = row
  dialogVisible.value = true
}

const showDetails = (row: any) => {
  selectedRoute.value = row
  detailsVisible.value = true
}

const handleDelete = async (id: number) => {
  try {
    await request.delete(`/routes/${id}`)
    ElMessage.success('删除成功')
    fetchData()
  } catch (e: any) {
    ElMessage.error('删除失败')
  }
}

const handleStatusChange = async (row: any) => {
  try {
    await request.put(`/routes/${row.id}`, { isActive: row.isActive })
    ElMessage.success('状态更新成功')
  } catch (e: any) {
    row.isActive = !row.isActive // Revert
    ElMessage.error('状态更新失败')
  }
}

onMounted(() => {
  fetchData()
})
</script>

