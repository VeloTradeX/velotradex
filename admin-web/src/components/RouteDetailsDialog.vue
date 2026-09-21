<template>
  <el-dialog v-model="visible" title="路由详情" width="900px">
    <div v-loading="detailsLoading">
      <el-descriptions title="基本信息" :column="2" border>
        <el-descriptions-item label="名称">{{ details.route?.name }}</el-descriptions-item>
        <el-descriptions-item label="频道 ID">{{ details.route?.channelId }}</el-descriptions-item>
        <el-descriptions-item label="交易所">
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <ExchangeLogo v-if="getExchange(details.route?.exchangeInstanceId)" :type="getExchange(details.route?.exchangeInstanceId).type" size="md" />
            <span>{{ getExchangeName(details.route?.exchangeInstanceId) }}</span>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="解析器">{{ details.parserName }}</el-descriptions-item>
        <el-descriptions-item label="支持交易对" :span="2">
          <div v-if="details.parsedSymbols && details.parsedSymbols.length > 0" style="max-height: 100px; overflow-y: auto;">
            <el-tag v-for="s in details.parsedSymbols" :key="s" size="small" style="margin-right: 5px; margin-bottom: 5px;">{{ s }}</el-tag>
          </div>
          <span v-else>全部 (All)</span>
        </el-descriptions-item>
      </el-descriptions>

      <div style="margin-top: 20px;">
        <h4>风控配置对比</h4>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-card shadow="never" class="config-card">
              <template #header>默认配置 (Parser)</template>
              <pre>{{ JSON.stringify(details.defaultConfig, null, 2) }}</pre>
            </el-card>
          </el-col>
          <el-col :span="8">
            <el-card shadow="never" class="config-card">
              <template #header>数据库配置 (Override)</template>
              <pre>{{ JSON.stringify(details.dbConfig, null, 2) }}</pre>
            </el-card>
          </el-col>
          <el-col :span="8">
            <el-card shadow="never" class="config-card effective">
              <template #header>当前生效 (Effective)</template>
              <pre>{{ JSON.stringify(details.effectiveConfig, null, 2) }}</pre>
            </el-card>
          </el-col>
        </el-row>
      </div>

      <div v-if="details.parsedSymbolSettings && Object.keys(details.parsedSymbolSettings).length > 0" style="margin-top: 20px;">
        <h4>额外风控配置 (Extra Risk Settings)</h4>
        <el-table :data="formatSymbolSettings(details.parsedSymbolSettings)" border size="small" style="width: 100%" max-height="200">
          <el-table-column prop="symbol" label="交易对" />
          <el-table-column prop="riskValue" label="风险值" />
        </el-table>
      </div>
    </div>
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="visible = false">关闭</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import request from '../utils/request'
import ExchangeLogo from './ExchangeLogo.vue'

const props = defineProps<{
  modelValue: boolean
  route: any | null
  exchanges: any[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const detailsLoading = ref(false)
const details = ref<any>({})

const getExchange = (id?: string) => {
  if (!id) return null
  return props.exchanges.find(e => e.id === id) || null
}

const getExchangeName = (id?: string) => {
  if (!id) return '-'
  const ex = getExchange(id)
  return ex ? `${ex.name} (${id})` : id
}

const formatSymbolSettings = (settings: any) => {
  if (!settings) return []
  return Object.keys(settings).map(key => ({
    symbol: key,
    riskValue: settings[key].riskValue
  }))
}

// 打开弹窗时拉取详情，等价于原 showDetails
watch(
  () => props.modelValue,
  async (open) => {
    if (!open || !props.route) return
    detailsLoading.value = true
    try {
      const res = await request.get(`/routes/${props.route.id}/details`)
      details.value = res.data

      // Parse supportedSymbols for display
      try {
        let symbols = details.value.route.supportedSymbols ? JSON.parse(details.value.route.supportedSymbols) : []
        if (typeof symbols === 'string') {
          symbols = JSON.parse(symbols)
        }
        details.value.parsedSymbols = Array.isArray(symbols) ? symbols : []
      } catch (e) {
        details.value.parsedSymbols = []
      }

      // Parse symbolSpecificSettings
      try {
        let settings = details.value.route.symbolSpecificSettings
        if (typeof settings === 'string') {
          settings = JSON.parse(settings)
        }
        // Filter out empty settings just in case
        const validSettings: any = {}
        if (settings) {
          for (const key in settings) {
            if (settings[key] && settings[key].riskValue !== '' && settings[key].riskValue !== null) {
              validSettings[key] = settings[key]
            }
          }
        }
        details.value.parsedSymbolSettings = validSettings
      } catch (e) {
        details.value.parsedSymbolSettings = {}
      }
    } catch (e: any) {
      ElMessage.error('获取详情失败')
    } finally {
      detailsLoading.value = false
    }
  }
)
</script>

<style scoped>
.config-card {
  height: 100%;
  overflow: auto;
}
.config-card pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 12px;
}
.effective {
  border-color: #67c23a;
}
</style>
