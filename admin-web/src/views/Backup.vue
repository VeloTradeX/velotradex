<template>
  <div class="backup-container">
    <el-row :gutter="20">
      <el-col :span="12">
        <el-card class="box-card">
          <template #header>
            <div class="card-header">
              <span>数据导出 (Backup)</span>
              <el-button type="primary" :icon="Download" @click="handleExport" :loading="exporting">导出选中数据</el-button>
            </div>
          </template>
          
          <div class="export-section">
            <el-alert
              title="提示"
              type="info"
              description="系统会自动识别并包含所选表的所有相关依赖表（外键关联）。"
              show-icon
              :closable="false"
              style="margin-bottom: 20px;"
            />

            <div class="table-selection">
              <el-checkbox v-model="checkAll" :indeterminate="isIndeterminate" @change="handleCheckAllChange">全选</el-checkbox>
              <div style="margin: 15px 0;"></div>
              <el-checkbox-group v-model="checkedTables" @change="handleCheckedTablesChange">
                <el-checkbox v-for="table in tables" :key="table" :label="table">{{ table }}</el-checkbox>
              </el-checkbox-group>
            </div>

            <el-divider>预览关联表</el-divider>
            <div class="related-preview">
                <p>将包含以下表: {{ relatedTables.join(', ') }}</p>
            </div>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="12">
        <el-card class="box-card">
          <template #header>
            <div class="card-header">
              <span>数据恢复 (Restore)</span>
            </div>
          </template>
          
          <div class="import-section">
            <el-alert
              title="警告"
              type="warning"
              description="恢复操作将清除目标表中的现有数据，并按依赖顺序重新插入备份数据。请谨慎操作！"
              show-icon
              :closable="false"
              style="margin-bottom: 20px;"
            />

            <el-upload
              class="upload-demo"
              drag
              action="/ct-api/backup/import"
              :headers="headers"
              :on-success="handleUploadSuccess"
              :on-error="handleUploadError"
              :before-upload="beforeUpload"
              accept=".zip"
            >
              <el-icon class="el-icon--upload"><upload-filled /></el-icon>
              <div class="el-upload__text">
                Drop file here or <em>click to upload</em>
              </div>
              <template #tip>
                <div class="el-upload__tip">
                  只能上传 .zip 格式的备份文件
                </div>
              </template>
            </el-upload>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { UploadFilled, Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import request from '../utils/request'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()
const tables = ref<string[]>([])
const checkedTables = ref<string[]>([])
const checkAll = ref(false)
const isIndeterminate = ref(false)
const relatedTables = ref<string[]>([])
const exporting = ref(false)

const headers = computed(() => ({
  Authorization: `Bearer ${authStore.token}`
}))

onMounted(async () => {
  await fetchTables()
})

const fetchTables = async () => {
  try {
    const res = await request.get('/backup/tables')
    tables.value = res.data // Expecting array directly as per backend code change? No, backend sends array.
    // Backend: ctx.body = backupService.getTables() -> array.
    // Axios response.data is the array.
  } catch (error) {
    ElMessage.error('获取表列表失败')
  }
}

const handleCheckAllChange = (val: boolean) => {
  checkedTables.value = val ? tables.value : []
  isIndeterminate.value = false
}

const handleCheckedTablesChange = (value: string[]) => {
  const checkedCount = value.length
  checkAll.value = checkedCount === tables.value.length
  isIndeterminate.value = checkedCount > 0 && checkedCount < tables.value.length
}

// Watch selection to update preview
watch(checkedTables, async (newVal) => {
    if (newVal.length === 0) {
        relatedTables.value = []
        return
    }
    try {
        const res = await request.post('/backup/related', { tables: newVal })
        relatedTables.value = res.data.related
    } catch (error) {
        console.error(error)
    }
})

const handleExport = async () => {
    if (checkedTables.value.length === 0) {
        ElMessage.warning('请至少选择一个表')
        return
    }
    
    exporting.value = true
    try {
        const res = await request.post('/backup/export', { tables: checkedTables.value }, {
            responseType: 'blob'
        })
        
        // Download
        const url = window.URL.createObjectURL(new Blob([res.data]))
        const link = document.createElement('a')
        link.href = url
        link.setAttribute('download', `backup-${new Date().toISOString()}.zip`)
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        ElMessage.success('导出成功')
    } catch (error) {
        ElMessage.error('导出失败')
    } finally {
        exporting.value = false
    }
}

const beforeUpload = (file: any) => {
    if (file.type !== 'application/zip' && !file.name.endsWith('.zip')) {
        ElMessage.error('Must be zip format!')
        return false
    }
    return true
}

const handleUploadSuccess = () => {
    ElMessage.success('恢复成功')
}

const handleUploadError = (err: any) => {
    ElMessage.error('恢复失败: ' + (err.message || 'Unknown error'))
}

</script>

<style scoped>
.backup-container {
    padding: 20px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.table-selection {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid #EBEEF5;
    padding: 10px;
    border-radius: 4px;
}
</style>
