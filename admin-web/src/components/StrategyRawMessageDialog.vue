<template>
  <el-dialog v-model="visible" width="60%">
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-right: 30px;">
        <span style="font-size: 18px;">原始消息详情</span>
        <div>
          <el-button size="small" @click="copyRawMessage">复制</el-button>
          <el-button type="warning" size="small" @click="resendStrategyMessage">重发消息</el-button>
        </div>
      </div>
    </template>
    <div v-if="strategy">
      <h3>Parsed Data</h3>
      <pre>{{ parsedData }}</pre>

      <h3>Raw Message Content</h3>
      <div class="raw-content" v-html="formatRawMessage(strategy.rawMessage)"></div>

      <div style="margin-top: 10px; color: #999; font-size: 12px;">
        注意：重发消息将把原始消息内容重新发送到 Redis，可能会触发新的交易。
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import request from '../utils/request'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps<{
  modelValue: boolean
  strategy: any | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const redisChannel = ref('')

const parsedData = computed(() => {
  if (!props.strategy) return ''
  try {
    return JSON.stringify(
      {
        symbol: props.strategy.symbol,
        action: props.strategy.action,
        side: props.strategy.side,
        entry: props.strategy.entryPrice,
        targets: JSON.parse(props.strategy.targets || '[]'),
        stopLoss: props.strategy.stopLoss
      },
      null,
      2
    )
  } catch {
    return ''
  }
})

const formatRawMessage = (rawJson: string) => {
  try {
    const data = JSON.parse(rawJson)
    // Discord message content is usually in 'content' field
    const content = data.content || JSON.stringify(data, null, 2)
    return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${content}</pre>`
  } catch (e) {
    return rawJson
  }
}

const copyRawMessage = async () => {
  if (!props.strategy) return
  try {
    await navigator.clipboard.writeText(props.strategy.rawMessage)
    ElMessage.success('已复制到剪贴板')
  } catch (err) {
    ElMessage.error('复制失败')
  }
}

const resendStrategyMessage = async () => {
  if (!props.strategy) return

  // Fetch channel first if not known
  if (!redisChannel.value) {
    try {
      const res = await request.get('/config/redis-channel')
      redisChannel.value = res.data.channel
    } catch (e) {}
  }

  try {
    await ElMessageBox.confirm(
      `确定要重发此消息吗？\n目标频道: ${redisChannel.value}\n这可能会再次触发交易！`,
      '二次确认',
      {
        confirmButtonText: '确定重发',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const rawContent = props.strategy.rawMessage
    // Attempt to parse if string
    let contentToSend = rawContent
    try {
      contentToSend = JSON.parse(rawContent)
    } catch (e) {}

    await request.post('/message/send', { content: contentToSend })
    ElMessage.success('重发成功')
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error('重发失败')
    }
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
  max-height: 300px;
  overflow-y: auto;
}
</style>
