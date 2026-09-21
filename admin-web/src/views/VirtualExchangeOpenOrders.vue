<template>
  <div class="page-container">
    <el-card class="filter-card">
      <div class="filter-header">
        <el-select v-model="filterExchange" placeholder="虚拟交易所实例" style="width: 220px;" clearable filterable @change="fetchOpenOrders" @clear="fetchOpenOrders">
          <el-option
              v-for="ex in exchanges"
              :key="ex.id"
              :label="formatExchangeLabel(ex)"
              :value="ex.id"
            >
              <div class="option-with-logo">
                <ExchangeLogo :type="ex.type" size="sm" />
                <span class="name-text">{{ ex.name }}</span>
              </div>
            </el-option>
        </el-select>
        <el-input v-model="filterSymbol" placeholder="交易对" style="width: 160px;" clearable @clear="fetchOpenOrders" />
        <el-select v-model="filterRole" placeholder="订单角色" style="width: 160px;" clearable @change="fetchOpenOrders" @clear="fetchOpenOrders">
          <el-option label="入场" value="entry" />
          <el-option label="止盈" value="tp" />
          <el
          <el-option label="止损" value="sl" />
          <el-option label="平仓" value="close" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="fetchOpenOrders">搜索</el-button>
        <el-button :icon="Refresh" @click="fetchOpenOrders">刷新</el-button>
      </div>
    </el-card>

    <div class="content-area">
      <el-table :data="openOrders" style="width: 100%" v-loading="loading" empty-text="暂无虚拟挂单">
        <el-table-column prop="createdAt" label="创建时间" width="180">
          <template #default="scope">{{ formatDate(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="virtualOrderId" label="虚拟订单 ID" min-width="180" />
        <el-table-column label="交易所" width="200">
          <template #default="scope">
            <div class="cell-with-logo">
              <ExchangeLogo :type="resolveExchangeType(scope.row)" size="sm" />
              <span>{{ scope.row.exchangeInstanceId || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="symbol" label="交易对" width="130" />
        <el-table-column prop="side" label="方向" width="100">
          <template #default="scope">
            <StatusBadge :value="scope.row.side" kind="side" />
          </template>
        </el-table-column>
        <el-table-column label="角色" width="110">
          <template #default="scope">
            <StatusBadge :value="scope.row.orderRole" kind="role" />
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="110">
          <template #default="scope">
            <StatusBadge :value="scope.row.type" />
          </template>
        </el-table-column>
        <el-table-column prop="price" label="价格" width="120">
          <template #default="scope">{{ formatNullable(scope.row.price) }}</template>
        </el-table-column>
        <el-table-column prop="triggerPrice" label="触发价格" width="130">
          <template #default="scope">{{ formatNullable(scope.row.triggerPrice) }}</template>
        </el-table-column>
        <el-table-column prop="triggerCondition" label="触发条件" width="100">
          <template #default="scope">{{ formatNullable(scope.row.triggerCondition) }}</template>
        </el-table-column>
        <el-table-column label="数量" width="130">
          <template #default="scope">{{ formatBaseAmount(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="scope">
            <el-button
              type="danger"
              size="small"
              :icon="Delete"
              :loading="cancelLoadingMap[scope.row.virtualOrderId]"
              @click="cancelOpenOrder(scope.row)"
            />
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Refresh, Search } from '@element-plus/icons-vue'
import request from '../utils/request'
import { useVirtualExchangeInstances } from '../composables/useVirtualExchangeInstances'
import { formatBaseAmount, formatNullable, formatDate } from '../utils/format'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

const { exchanges, fetchExchanges, formatExchangeLabel } = useVirtualExchangeInstances()

const openOrders = ref<any[]>([])
const loading = ref(false)
const cancelLoadingMap = ref<Record<string, boolean>>({})
const filterExchange = ref('')
const filterSymbol = ref('')
const filterRole = ref('')

const cancelOpenOrder = async (row: any) => {
  try {
    await ElMessageBox.confirm(`确认取消 ${row.symbol} 的挂单 ${row.virtualOrderId}？`, '取消挂单', {
      confirmButtonText: '确认取消',
      cancelButtonText: '返回',
      type: 'warning',
    })
  } catch {
    return
  }

  cancelLoadingMap.value[row.virtualOrderId] = true
  try {
    await request.post(`/virtual-exchange/open-orders/${row.virtualOrderId}/cancel`, null, {
      params: {
        exchangeInstanceId: row.exchangeInstanceId,
        symbol: row.symbol,
      },
    })
    ElMessage.success('挂单已取消')
    await fetchOpenOrders()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '取消虚拟挂单失败')
  } finally {
    cancelLoadingMap.value[row.virtualOrderId] = false
  }
}

function resolveExchangeType(row: any) {
  if (!row) return 'virtual_gate'
  const id = row.exchangeInstanceId || row.exchangeId
  if (id) {
    const ex = exchanges.value.find((e: any) => e.id === id)
    if (ex) return ex.type
  }
  return 'virtual_gate'
}

const fetchOpenOrders = async () => {
  loading.value = true
  try {
    const params: any = { limit: 100 }
    if (filterExchange.value) params.exchangeInstanceId = filterExchange.value
    if (filterSymbol.value) params.symbol = filterSymbol.value
    if (filterRole.value) params.orderRole = filterRole.value

    const res = await request.get('/virtual-exchange/open-orders', { params })
    openOrders.value = res.data
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '获取虚拟挂单失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await fetchExchanges()
  await fetchOpenOrders()
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
  gap: 12px;
}

.content-area {
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 20px;
}

</style>
