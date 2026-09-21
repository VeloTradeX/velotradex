<template>
  <el-dialog v-model="visible" title="消息解析验证" width="80%" top="5vh" @open="onOpen">
    <div style="margin-bottom: 15px;">
      <span style="margin-right: 10px;">选择解析器:</span>
      <el-select v-model="selectedParser" placeholder="选择解析器" style="width: 300px;">
        <el-option
          v-for="item in parsers"
          :key="item.name"
          :label="`${item.name} (${item.channelId || '-'})`"
          :value="item.name"
        />
      </el-select>
    </div>

    <div style="display: flex; gap: 20px; height: 70vh;">
      <div style="flex: 1; display: flex; flex-direction: column;">
        <div style="margin-bottom: 5px; font-weight: bold;">原始消息 (JSON):</div>
        <el-input
          v-model="parseContent"
          type="textarea"
          :rows="15"
          placeholder="请输入原始消息 JSON"
          style="font-family: monospace; flex: 1;"
          resize="none"
        />
        <div style="margin-top: 10px; text-align: right;">
          <el-button type="primary" @click="testParseMessage" :loading="parsing">开始解析</el-button>
        </div>
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <div style="margin-bottom: 5px; font-weight: bold;">解析结果:</div>
        <div class="raw-content" style="flex: 1; overflow-y: auto;">
          <pre v-if="parseResult" style="white-space: pre-wrap; word-wrap: break-word;">{{ JSON.stringify(parseResult, null, 2) }}</pre>
          <div v-else style="color: #999; padding: 20px; text-align: center;">暂无结果</div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = ref(false)
const syncVisible = () => emit('update:modelValue', visible.value)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, syncVisible)

// Parse Message State
const parsers = ref<any[]>([])
const selectedParser = ref('')
const parseContent = ref('')
const parseResult = ref<any>(null)
const parsing = ref(false)

const onOpen = async () => {
  parseResult.value = null
  // Fetch Parsers
  try {
    const res = await request.get('/parsers')
    parsers.value = res.data
    if (parsers.value.length > 0) {
      selectedParser.value = parsers.value[0].name
    }
  } catch (e) {
    console.error(e)
  }
}

const testParseMessage = async () => {
  if (!selectedParser.value || !parseContent.value) {
    ElMessage.warning('请选择解析器并输入内容')
    return
  }

  try {
    let contentObj
    try {
      contentObj = JSON.parse(parseContent.value)
    } catch (e) {
      // If parsing fails, treat input as raw content string and wrap it
      contentObj = { content: parseContent.value }
    }

    parsing.value = true

    // Find the parser object to get channelId if available
    const parserObj = parsers.value.find((p) => p.name === selectedParser.value)

    const res = await request.post('/parser/test', {
      channelId: parserObj?.channelId,
      parser: selectedParser.value,
      content: contentObj
    })

    parseResult.value = res.data.result
    ElMessage.success('解析完成')
  } catch (e: any) {
    console.error(e)
    ElMessage.error('解析失败: ' + (e.response?.data?.error || e.message))
    parseResult.value = { error: e.message }
  } finally {
    parsing.value = false
  }
}
</script>

<style scoped>
.raw-content {
  background-color: var(--bg-color-base);
  color: var(--text-color-primary);
  border: 1px solid var(--border-color-base);
  padding: 10px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
