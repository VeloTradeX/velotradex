<template>
  <div class="users-container">
    <div class="header">
      <el-button type="primary" :icon="Plus" @click="handleAddUser">新增用户</el-button>
    </div>

    <el-table :data="users" v-loading="loading" style="width: 100%">
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="username" label="用户名" />
      <el-table-column prop="role" label="角色" width="100">
        <template #default="scope">
          <StatusBadge :value="scope.row.role" kind="role" />
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间">
        <template #default="scope">
          {{ formatDate(scope.row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="scope">
          <el-button size="small" @click="handleEdit(scope.row)">编辑</el-button>
          <el-button size="small" type="danger" @click="handleDelete(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- User Dialog -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="400px">
      <el-form :model="form" label-width="80px" :rules="rules" ref="formRef">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" :disabled="isEdit" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password placeholder="不修改请留空" v-if="isEdit" />
          <el-input v-model="form.password" type="password" show-password v-else />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="form.role">
            <el-option label="管理员" value="admin" />
            <el-option label="查看者" value="viewer" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import request from '../utils/request'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { formatDate } from '../utils/format'
import StatusBadge from '../components/StatusBadge.vue'

const users = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const isEdit = ref(false)
const formRef = ref(null)

const form = reactive({
  id: null,
  username: '',
  password: '',
  role: 'viewer'
})

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: false, message: '请输入密码', trigger: 'blur' }], // Dynamic check in submit
  role: [{ required: true, message: '请选择角色', trigger: 'change' }]
}

const dialogTitle = computed(() => isEdit.value ? '编辑用户' : '新增用户')

const fetchUsers = async () => {
  loading.value = true
  try {
    const res = await request.get('/users')
    users.value = res.data
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '获取用户列表失败')
  } finally {
    loading.value = false
  }
}

const handleAddUser = () => {
  isEdit.value = false
  form.id = null
  form.username = ''
  form.password = ''
  form.role = 'viewer'
  dialogVisible.value = true
}

const handleEdit = (row: any) => {
  isEdit.value = true
  form.id = row.id
  form.username = row.username
  form.password = '' // Don't show old password
  form.role = row.role
  dialogVisible.value = true
}

const handleDelete = (row: any) => {
  ElMessageBox.confirm(`确定要删除用户 ${row.username} 吗?`, '警告', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await request.delete(`/users/${row.id}`)
      ElMessage.success('删除成功')
      fetchUsers()
    } catch (e: any) {
      ElMessage.error(e.response?.data?.error || '删除失败')
    }
  })
}

const submitForm = async () => {
  if (!formRef.value) return
  
  // Custom validation for password
  if (!isEdit.value && !form.password) {
      ElMessage.warning('请输入密码')
      return
  }

  await (formRef.value as any).validate(async (valid: boolean) => {
    if (valid) {
      submitting.value = true
      try {
        if (isEdit.value) {
          const payload: any = { role: form.role }
          if (form.password) payload.password = form.password
          await request.put(`/users/${form.id}`, payload)
          ElMessage.success('更新成功')
        } else {
          await request.post('/users', {
            username: form.username,
            password: form.password,
            role: form.role
          })
          ElMessage.success('创建成功')
        }
        dialogVisible.value = false
        fetchUsers()
      } catch (e: any) {
        ElMessage.error(e.response?.data?.error || '操作失败')
      } finally {
        submitting.value = false
      }
    }
  })
}

onMounted(() => {
  fetchUsers()
})
</script>

<style scoped>
.header {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  margin-bottom: 20px;
}
</style>
