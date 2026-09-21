<template>
  <el-dialog v-model="visible" title="发送在线消息" width="60%" @open="onOpen">
    <div style="margin-bottom: 15px;">
      <span style="font-weight: bold;">目标频道 (Redis Channel): </span>
      <el-tag>{{ redisChannel }}</el-tag>
    </div>

    <div style="margin-bottom: 15px;">
      <span style="margin-right: 10px;">选择解析器:</span>
      <el-select
        v-model="sendSelectedParser"
        placeholder="Select Parser (Optional)"
        style="width: 300px;"
        clearable
        :disabled="sendParserDisabled"
      >
        <el-option
          v-for="item in parsers"
          :key="item.name"
          :label="`${item.name} (${item.channelId || '-'})`"
          :value="item.channelId"
          :disabled="!item.channelId"
        />
      </el-select>
      <span style="margin-left: 10px; color: #999; font-size: 12px;">
        如果消息中没有 channel_id，将自动使用所选解析器的 ID。
      </span>
    </div>

    <div style="margin-bottom: 5px; display: flex; justify-content: flex-end; gap: 10px;">
      <el-button size="small" @click="formatMessageContent">格式化 JSON</el-button>
      <el-button size="small" @click="clearMessageContent">清空</el-button>
    </div>

    <el-input
      v-model="messageContent"
      type="textarea"
      :rows="15"
      placeholder="请输入消息内容 (JSON 或 纯文本)"
      style="font-family: monospace;"
      @input="checkMessageContent"
    />

    <div style="margin-top: 10px;" v-if="messageHistory.length > 0">
      <span style="margin-right: 10px; font-size: 12px; color: #666;">历史消息:</span>
      <el-tooltip
        v-for="(msg, index) in messageHistory"
        :key="index"
        :content="msg.length > 30 ? msg.substring(0, 30) + '...' : msg"
        placement="top"
        effect="dark"
        :show-after="2000"
      >
        <el-button size="small" @click="loadHistoryMsg(msg)">{{ index + 1 }}</el-button>
      </el-tooltip>
    </div>

    <template #footer>
      <span class="dialog-footer">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="sendMessage" :loading="sending">发送</el-button>
      </span>
    </template>
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
// 双向绑定：写入时同步回父组件
const syncVisible = () => emit('update:modelValue', visible.value)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, syncVisible)

// Send Message State
const messageContent = ref('')
const redisChannel = ref('')
const sending = ref(false)
const sendSelectedParser = ref('')
const sendParserDisabled = ref(false)
const messageHistory = ref<string[]>([])
const parsers = ref<any[]>([])

const onOpen = async () => {
  sendSelectedParser.value = ''
  sendParserDisabled.value = false

  // Fetch Parsers
  try {
    const res = await request.get('/parsers')
    parsers.value = res.data
    // Only pre-select if it has a channelId
    const validParser = parsers.value.find((p) => p.channelId)
    if (validParser) {
      sendSelectedParser.value = validParser.channelId
    }
  } catch (e) {
    console.error(e)
  }

  // Fetch config
  try {
    const res = await request.get('/config/redis-channel')
    redisChannel.value = res.data.channel
  } catch (e) {
    console.error(e)
  }
  // Load from local storage
  try {
    const historyStr = localStorage.getItem('message_history')
    if (historyStr) {
      messageHistory.value = JSON.parse(historyStr)
    }
  } catch (e) {
    messageHistory.value = []
  }

  const lastMsg = localStorage.getItem('last_sent_message')
  if (lastMsg) {
    messageContent.value = lastMsg
    checkMessageContent()
  } else {
    messageContent.value = '{\n  "content": "Hello World"\n}'
  }
}

const loadHistoryMsg = (val: string) => {
  if (val) {
    messageContent.value = val
    checkMessageContent()
  }
}

const checkMessageContent = () => {
  try {
    const obj = JSON.parse(messageContent.value)
    if (obj.channel_id) {
      sendSelectedParser.value = ''
      sendParserDisabled.value = true
    } else {
      sendParserDisabled.value = false
    }
  } catch (e) {
    // Not JSON, so definitely no channel_id in JSON structure
    sendParserDisabled.value = false
  }
}

const formatMessageContent = () => {
  try {
    const obj = JSON.parse(messageContent.value)
    messageContent.value = JSON.stringify(obj, null, 2)
    checkMessageContent()
  } catch (e) {
    ElMessage.error('Invalid JSON')
  }
}

const clearMessageContent = () => {
  messageContent.value = ''
  sendParserDisabled.value = false
}

const sendMessage = async () => {
  if (!messageContent.value) return

  try {
    let contentObj
    try {
      contentObj = JSON.parse(messageContent.value)
    } catch (e) {
      // Not JSON, assume raw content
      contentObj = { content: messageContent.value }
    }

    // Inject channel_id if needed
    if (!contentObj.channel_id && sendSelectedParser.value) {
      contentObj.channel_id = sendSelectedParser.value
    }

    sending.value = true
    await request.post('/message/send', { content: contentObj })

    ElMessage.success('消息发送成功')
    localStorage.setItem('last_sent_message', messageContent.value)

    // Update history
    const currentMsg = messageContent.value
    // Remove if exists to move to top
    const idx = messageHistory.value.indexOf(currentMsg)
    if (idx > -1) {
      messageHistory.value.splice(idx, 1)
    }
    messageHistory.value.unshift(currentMsg)
    if (messageHistory.value.length > 10) {
      messageHistory.value = messageHistory.value.slice(0, 10)
    }
    localStorage.setItem('message_history', JSON.stringify(messageHistory.value))

    visible.value = false
  } catch (e: any) {
    console.error(e)
    ElMessage.error('发送失败: ' + (e.response?.data?.error || e.message))
  } finally {
    sending.value = false
  }
}
</script>
