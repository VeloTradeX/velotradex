<template>
  <div class="api-credentials-container">
    <div class="header">
      <h2>API 凭证</h2>
      <el-button type="primary" :icon="Plus" @click="openCreateDialog">新增凭证</el-button>
    </div>

    <el-table :data="credentials" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column prop="tokenPrefix" label="Token 前缀" min-width="180" />
      <el-table-column label="权限范围" min-width="240">
        <template #default="scope">
          <el-tag v-for="item in scope.row.scopes" :key="item" size="small" class="scope-tag">
            {{ item }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="scope">
          <StatusBadge :value="scope.row.status" kind="status" />
        </template>
      </el-table-column>
      <el-table-column label="过期时间" min-width="170">
        <template #default="scope">{{ formatDate(scope.row.expiresAt) }}</template>
      </el-table-column>
      <el-table-column label="最后使用" min-width="170">
        <template #default="scope">{{ formatDate(scope.row.lastUsedAt) }}</template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="170">
        <template #default="scope">{{ formatDate(scope.row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="scope">
          <el-button size="small" :disabled="scope.row.status !== 'active'" @click="disableCredential(scope.row)">禁用</el-button>
          <el-button size="small" type="danger" @click="deleteCredential(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createDialogVisible" title="新增 API 凭证" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如 AI 诊断 CLI" />
        </el-form-item>
        <el-form-item label="权限范围">
          <el-checkbox-group v-model="form.scopes">
            <el-checkbox v-for="scope in availableScopes" :key="scope" :label="scope" />
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="过期时间">
          <el-date-picker
            v-model="form.expiresAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="可选"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="createCredential">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="tokenDialogVisible" title="请立即保存 Token" width="640px">
      <el-alert
        title="完整 token 只会显示这一次，关闭后无法再次查看。"
        type="warning"
        show-icon
        :closable="false"
        class="token-alert"
      />
      <el-input v-model="createdToken" readonly>
        <template #append>
          <el-button @click="copyToken">复制</el-button>
        </template>
      </el-input>
      <template #footer>
        <el-button type="primary" @click="tokenDialogVisible = false">已保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { formatDate } from '../utils/format'
import request from '../utils/request'
import StatusBadge from '../components/StatusBadge.vue'

const defaultScopes = ['orders:read', 'strategies:read', 'logs:read', 'audit:read', 'exchanges:read', 'positions:read']

const credentials = ref<any[]>([])
const availableScopes = ref<string[]>(defaultScopes)
const loading = ref(false)
const submitting = ref(false)
const createDialogVisible = ref(false)
const tokenDialogVisible = ref(false)
const createdToken = ref('')

const form = reactive({
  name: '',
  scopes: [...defaultScopes],
  expiresAt: ''
})

const fetchCredentials = async () => {
  loading.value = true
  try {
    const res = await request.get('/api-credentials')
    credentials.value = res.data
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '获取 API 凭证失败')
  } finally {
    loading.value = false
  }
}

const fetchScopes = async () => {
  try {
    const res = await request.get('/api-credentials/scopes')
    availableScopes.value = res.data.scopes || defaultScopes
  } catch {
    availableScopes.value = defaultScopes
  }
}

const openCreateDialog = () => {
  form.name = ''
  form.scopes = [...availableScopes.value]
  form.expiresAt = ''
  createDialogVisible.value = true
}

const createCredential = async () => {
  if (!form.name.trim()) {
    ElMessage.warning('请输入名称')
    return
  }
  if (form.scopes.length === 0) {
    ElMessage.warning('至少选择一个 scope')
    return
  }

  submitting.value = true
  try {
    const res = await request.post('/api-credentials', {
      name: form.name,
      scopes: form.scopes,
      expiresAt: form.expiresAt || null
    })
    createdToken.value = res.data.token
    createDialogVisible.value = false
    tokenDialogVisible.value = true
    await fetchCredentials()
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '创建失败')
  } finally {
    submitting.value = false
  }
}

const copyToken = async () => {
  await navigator.clipboard.writeText(createdToken.value)
  ElMessage.success('已复制')
}

const disableCredential = async (row: any) => {
  await ElMessageBox.confirm(`确定禁用 ${row.name} 吗?`, '确认', { type: 'warning' })
  await request.post(`/api-credentials/${row.id}/disable`)
  ElMessage.success('已禁用')
  fetchCredentials()
}

const deleteCredential = async (row: any) => {
  await ElMessageBox.confirm(`确定删除 ${row.name} 吗?`, '警告', { type: 'warning' })
  await request.delete(`/api-credentials/${row.id}`)
  ElMessage.success('已删除')
  fetchCredentials()
}

onMounted(async () => {
  await fetchScopes()
  await fetchCredentials()
})
</script>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.scope-tag {
  margin-right: 6px;
  margin-bottom: 4px;
}

.token-alert {
  margin-bottom: 16px;
}
</style>
