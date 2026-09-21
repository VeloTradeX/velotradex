<template>
    <div class="page-container">
        <el-card class="filter-card">
            <div class="filter-header">
                <div class="left-panel">
                    <el-input v-model="filterName" placeholder="按名称过滤" style="width: 150px; margin-right: 10px;" clearable
                        :prefix-icon="Search" />
                    <el-select v-model="filterType" placeholder="按类型过滤" style="width: 170px; margin-right: 10px;" clearable>
                        <el-option label="Gate.io" value="gate">
                            <div class="option-with-logo">
                                <ExchangeLogo type="gate" size="sm" />
                                <span>Gate.io</span>
                            </div>
                        </el-option>
                        <el-option label="Gate TradFi" value="gate_tradfi">
                            <div class="option-with-logo">
                                <ExchangeLogo type="gate_tradfi" size="sm" />
                                <span>Gate TradFi</span>
                            </div>
                        </el-option>
                        <el-option label="Virtual Gate" value="virtual_gate">
                            <div class="option-with-logo">
                                <ExchangeLogo type="virtual_gate" size="sm" />
                                <span>Virtual Gate</span>
                            </div>
                        </el-option>
                        <el-option label="Virtual Gate TradFi" value="virtual_gate_tradfi">
                            <div class="option-with-logo">
                                <ExchangeLogo type="virtual_gate_tradfi" size="sm" />
                                <span>Virtual Gate TradFi</span>
                            </div>
                        </el-option>
                        <el-option label="Binance" value="binance">
                            <div class="option-with-logo">
                                <ExchangeLogo type="binance" size="sm" />
                                <span>Binance</span>
                            </div>
                        </el-option>
                        <el-option label="Lighter" value="lighter">
                            <div class="option-with-logo">
                                <ExchangeLogo type="lighter" size="sm" />
                                <span>Lighter</span>
                            </div>
                        </el-option>
                    </el-select>
                    <el-button type="primary" :icon="Search" @click="fetchExchanges" :loading="loading">搜索</el-button>
                    <el-button type="primary" :icon="Plus" @click="handleAdd">添加交易所</el-button>
                </div>
            </div>
        </el-card>

        <div class="content-area">
            <el-table :data="filteredExchanges" v-loading="loading" style="width: 100%" class="data-table">
                <el-table-column prop="id" label="ID" width="150" show-overflow-tooltip />
                <el-table-column prop="name" label="名称" width="210" show-overflow-tooltip>
                    <template #default="scope">
                        <span class="name-text">{{ scope.row.name }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="type" label="类型" width="180">
                    <template #default="scope">
                        <div class="cell-with-logo">
                            <ExchangeLogo :type="scope.row.type" size="sm" />
                            <span>{{ typeName(scope.row.type) }}</span>
                        </div>
                    </template>
                </el-table-column>
                <el-table-column label="余额" width="170">
                    <template #default="scope">
                        <el-tooltip
                            v-if="scope.row.balance"
                            :content="balanceTooltip(scope.row.balance)"
                            placement="top"
                        >
                            <span class="balance-text">{{ formatBalance(scope.row.balance) }}</span>
                        </el-tooltip>
                        <span v-else class="balance-empty">-</span>
                    </template>
                </el-table-column>
                <el-table-column prop="status" label="状态" width="110">
                    <template #default="scope">
                        <StatusBadge :value="scope.row.status" kind="status" />
                    </template>
                </el-table-column>
                <el-table-column label="连接状态" width="130">
                    <template #default="scope">
                        <span class="status-pill" :class="scope.row.connected ? 'pill-ok' : 'pill-fail'">
                            <el-icon :size="12">
                                <CircleCheck v-if="scope.row.connected" />
                                <CircleClose v-else />
                            </el-icon>
                            {{ scope.row.connected ? '已连接' : '已断开' }}
                        </span>
                    </template>
                </el-table-column>
                <el-table-column label="操作" fixed="right">
                    <template #default="scope">
                        <el-button size="small" :icon="Edit" @click="handleEdit(scope.row)">编辑</el-button>
                        <el-popconfirm title="确定删除吗？" @confirm="handleDelete(scope.row.id)">
                            <template #reference>
                                <el-button size="small" type="danger" :icon="Delete">删除</el-button>
                            </template>
                        </el-popconfirm>
                    </template>
                </el-table-column>
            </el-table>
        </div>

        <ExchangeFormDialog
            v-model="dialogVisible"
            ref="dialogRef"
            @saved="fetchExchanges"
        />
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { Search, Plus, Edit, Delete, CircleCheck, CircleClose } from '@element-plus/icons-vue'
import ExchangeFormDialog from '../components/ExchangeFormDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ExchangeLogo from '../components/ExchangeLogo.vue'

const api = request
const exchanges = ref<any[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const dialogRef = ref<InstanceType<typeof ExchangeFormDialog> | null>(null)

const filterName = ref('')
const filterType = ref('')

// 交易所类型 → 展示名（表格类型列 / 过滤项复用）
const TYPE_LABELS: Record<string, string> = {
    gate: 'Gate.io',
    gate_tradfi: 'Gate TradFi',
    gate_cfd: 'Gate TradFi',
    virtual_gate: 'Virtual Gate',
    virtual_gate_tradfi: 'Virtual Gate TradFi',
    binance: 'Binance',
    lighter: 'Lighter',
}

const typeName = (type: string) => TYPE_LABELS[type] || type

// 余额展示：主显净值（total + 币种），附悬停明细
const formatBalance = (balance: any) => {
    const currency = balance.currency || 'USDT'
    const total = Number(balance.total)
    if (!Number.isFinite(total)) return '-'
    return `${total.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`
}

const balanceTooltip = (balance: any) => {
    const currency = balance.currency || 'USDT'
    const available = Number(balance.available)
    const unrealized = Number(balance.unrealizedPnl)
    const parts = [`可用: ${Number.isFinite(available) ? available.toFixed(4) : '-'} ${currency}`]
    if (Number.isFinite(unrealized) && unrealized !== 0) {
        parts.push(`未实现盈亏: ${unrealized.toFixed(4)} ${currency}`)
    }
    return parts.join('  |  ')
}

const filteredExchanges = computed(() => {
    return exchanges.value.filter(e => {
        const matchName = !filterName.value || e.name.toLowerCase().includes(filterName.value.toLowerCase())
        const matchType = !filterType.value || e.type === filterType.value
        return matchName && matchType
    })
})

const fetchExchanges = async () => {
    loading.value = true
    try {
        const res = await api.get('/exchanges')
        exchanges.value = res.data
    } catch (e: any) {
        ElMessage.error(e.message)
    } finally {
        loading.value = false
    }
}

const handleAdd = () => {
    dialogRef.value?.open()
}

const handleEdit = (row: any) => {
    dialogRef.value?.open(row)
}

const handleDelete = async (id: string) => {
    try {
        await api.delete(`/exchanges/${id}`)
        ElMessage.success('删除成功')
        fetchExchanges()
    } catch (e: any) {
        ElMessage.error('删除失败')
    }
}

onMounted(() => {
    fetchExchanges()
})
</script>

<style scoped>
.option-with-logo {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.cell-with-logo {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

.name-text {
    font-weight: 500;
}

.balance-text {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
}

.balance-empty {
    color: #909399;
}

.status-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid transparent;
    white-space: nowrap;
}

.pill-ok {
    color: #529b2e;
    background-color: #eaf7e6;
    border-color: #b3e19d;
}

.pill-fail {
    color: #c0392b;
    background-color: #fdecea;
    border-color: #f5c6c0;
}
</style>
