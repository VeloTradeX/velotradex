<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑告警配置' : '新建告警配置'"
    width="700px"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="例如: 飞书群通知" />
      </el-form-item>

      <el-form-item label="告警方式" prop="type">
        <el-select v-model="form.type" placeholder="选择告警方式" style="width: 100%">
          <el-option label="通用 Webhook" value="webhook" />
          <el-option label="飞书 (Feishu/Lark)" value="feishu" />
          <el-option label="钉钉 (DingTalk)" value="dingtalk" />
          <el-option label="Pushover" value="pushover" />
        </el-select>
      </el-form-item>

      <!-- Dynamic Form Fields -->

      <!-- Webhook Specific -->
      <template v-if="form.type === 'webhook'">
        <el-form-item label="Webhook 地址" prop="url">
          <el-input v-model="form.url" placeholder="https://..." />
        </el-form-item>
        <el-form-item label="请求方法" prop="method">
          <el-select v-model="form.method" placeholder="选择请求方法">
            <el-option label="POST" value="POST" />
            <el-option label="GET" value="GET" />
            <el-option label="PUT" value="PUT" />
          </el-select>
        </el-form-item>
        <el-form-item label="请求头" prop="headers">
          <el-input
            v-model="form.headers"
            type="textarea"
            :rows="3"
            placeholder='JSON 格式，例如: {"Authorization": "Bearer token"}'
          />
        </el-form-item>
        <el-form-item label="请求体模板" prop="template">
          <el-input
            v-model="form.template"
            type="textarea"
            :rows="4"
            placeholder='可使用变量: ${event}, ${symbol}, ${side}, ${price}, ${amount}, ${orderId} 等。如果不填则发送完整 JSON。'
          />
          <div class="form-tip">
            支持变量: ${event}, ${timestamp}, ${symbol}, ${side}, ${price}, ${size}, ${amount}, ${orderId}, ${strategyId}, ${error}。<br>
            示例: {"content": "订单 ${orderId} 已创建: ${symbol} ${side}"}
          </div>
        </el-form-item>
      </template>

      <!-- Feishu Specific -->
      <template v-if="form.type === 'feishu'">
        <el-form-item label="Webhook 地址" prop="url">
          <el-input v-model="form.url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
          <div class="form-tip">请输入飞书机器人的 Webhook 地址</div>
        </el-form-item>
      </template>

      <!-- DingTalk Specific -->
      <template v-if="form.type === 'dingtalk'">
        <el-form-item label="Webhook 地址" prop="url">
          <el-input v-model="form.url" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
          <div class="form-tip">请输入钉钉机器人的 Webhook 地址</div>
        </el-form-item>
      </template>

      <!-- Pushover Specific -->
      <template v-if="form.type === 'pushover'">
        <el-form-item label="User Key" prop="pushoverUserKey">
          <el-input v-model="form.pushoverUserKey" placeholder="Pushover User Key" />
        </el-form-item>
        <el-form-item label="App Token" prop="pushoverToken">
          <el-input v-model="form.pushoverToken" placeholder="Pushover Application Token" />
        </el-form-item>
      </template>

      <el-form-item label="订阅事件" prop="events">
        <div class="events-container">
          <el-checkbox v-model="isAllEvents" @change="handleAllEventsChange" class="all-events-checkbox">所有事件 (*)</el-checkbox>

          <div v-if="!isAllEvents" class="event-checkbox-group">
            <div v-for="(group, gIndex) in eventGroups" :key="gIndex" class="event-group">
              <div class="group-title">{{ group.label }}</div>
              <div class="group-items">
                <el-checkbox
                  v-for="item in group.options"
                  :key="item.value"
                  v-model="form.events"
                  :label="item.value"
                >
                  <el-tooltip
                    effect="dark"
                    :content="item.tip"
                    placement="top"
                  >
                    <span>{{ item.label }}</span>
                  </el-tooltip>
                </el-checkbox>
              </div>
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="状态" prop="isActive">
        <el-switch v-model="form.isActive" active-text="启用" inactive-text="禁用" />
      </el-form-item>
    </el-form>
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit">确定</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import request from '../utils/request'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: []
}>()

const visible = ref(false)
const syncVisible = () => emit('update:modelValue', visible.value)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, syncVisible)

const formRef = ref()
const isEdit = ref(false)
const isAllEvents = ref(false)

const form = reactive({
  id: 0,
  name: '',
  type: 'webhook',
  url: '',
  method: 'POST',
  headers: '{}',
  template: '',
  pushoverUserKey: '',
  pushoverToken: '',
  events: [] as string[],
  isActive: true
})

const eventGroups = [
  {
    label: '订单类 (Orders)',
    options: [
      { label: '订单初始化', value: 'ORDER_INIT', tip: '策略生成并准备下单' },
      { label: '挂单成功', value: 'ORDER_CREATED', tip: '成功向交易所提交挂单' },
      { label: '订单成交', value: 'ORDER_FILLED_WS', tip: '订单完全成交' },
      { label: '下单失败', value: 'ORDER_FAILED', tip: 'API 错误或余额不足' },
      { label: '订单取消', value: 'ORDER_CANCELLED', tip: '订单被取消' },
      { label: '触发平仓', value: 'ORDER_CLOSED_BY_TRIGGER', tip: '止损/止盈触发平仓' },
      { label: '主动平仓', value: 'ORDER_CLOSED_POSITION', tip: '策略发出平仓信号' }
    ]
  },
  {
    label: '策略与异常 (Strategy & Errors)',
    options: [
      { label: '发现信号', value: 'STRATEGY_DETECTED', tip: '收到原始信号并解析成功' },
      { label: '信号过滤', value: 'STRATEGY_FILTERED', tip: '信号因配置被忽略' },
      { label: '解析错误', value: 'PARSER_ERROR', tip: '无法解析消息内容' },
      { label: '策略错误', value: 'STRATEGY_SAVE_ERROR', tip: '策略保存入库失败' }
    ]
  },
  {
    label: '交易执行 (Execution)',
    options: [
      { label: '放置止盈', value: 'TP_ORDER_PLACED', tip: '成功放置止盈单' },
      { label: '止盈失败', value: 'TP_PLACEMENT_FAILED', tip: '止盈单放置失败' }
    ]
  }
]

const rules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择告警方式', trigger: 'change' }],
}

const handleAllEventsChange = (val: boolean) => {
  if (val) {
    form.events = ['*']
  } else {
    form.events = []
  }
}

// Watch events changes to uncheck "All" if user manually selects/deselects
watch(() => form.events, (newVal) => {
  if (newVal.includes('*') && newVal.length > 1) {
    isAllEvents.value = true
    form.events = ['*'] // Enforce single value
  } else if (newVal.includes('*')) {
    isAllEvents.value = true
  } else {
    isAllEvents.value = false
  }
})

const handleSubmit = async () => {
  if (!formRef.value) return

  await formRef.value.validate(async (valid: boolean) => {
    if (valid) {
      // Custom Validation
      if (form.type === 'webhook' && !form.url) {
        ElMessage.error('Webhook URL 不能为空'); return
      }
      if ((form.type === 'feishu' || form.type === 'dingtalk') && !form.url) {
        ElMessage.error('Webhook URL 不能为空'); return
      }
      if (form.type === 'pushover' && (!form.pushoverUserKey || !form.pushoverToken)) {
        ElMessage.error('Pushover User Key 和 App Token 必填'); return
      }

      try {
        // Build Config JSON
        let extraConfig = {}
        if (form.type === 'pushover') {
          extraConfig = { userKey: form.pushoverUserKey, token: form.pushoverToken }
        }

        const payload = {
          name: form.name,
          type: form.type,
          url: form.url,
          method: form.method,
          headers: form.headers,
          template: form.template,
          config: extraConfig,
          events: isAllEvents.value ? ['*'] : form.events,
          isActive: form.isActive
        }

        if (isEdit.value) {
          await request.put(`/webhooks/${form.id}`, payload)
          ElMessage.success('更新成功')
        } else {
          await request.post('/webhooks', payload)
          ElMessage.success('创建成功')
        }
        visible.value = false
        emit('saved')
      } catch (error: any) {
        ElMessage.error(error.response?.data?.error || '操作失败')
      }
    }
  })
}

const open = (row?: any) => {
  if (row) {
    isEdit.value = true
    form.id = row.id
    form.name = row.name
    form.type = row.type || 'webhook'
    form.url = row.url
    form.method = row.method || 'POST'
    form.headers = row.headers
    form.template = row.template || ''
    form.events = Array.isArray(row.events) ? row.events : []
    isAllEvents.value = form.events.includes('*')
    form.isActive = row.isActive

    // Parse config for Pushover
    try {
      const conf = JSON.parse(row.config || '{}')
      form.pushoverUserKey = conf.userKey || ''
      form.pushoverToken = conf.token || ''
    } catch (e) {
      form.pushoverUserKey = ''
      form.pushoverToken = ''
    }
  } else {
    isEdit.value = false
    form.id = 0
    form.name = ''
    form.type = 'webhook'
    form.url = ''
    form.method = 'POST'
    form.headers = '{}'
    form.template = ''
    form.pushoverUserKey = ''
    form.pushoverToken = ''
    form.events = []
    isAllEvents.value = false
    form.isActive = true
  }
  visible.value = true
}

defineExpose({ open })
</script>

<style scoped>
.form-tip {
    font-size: 12px;
    color: #909399;
    line-height: 1.2;
    margin-top: 4px;
}
.event-group {
    margin-bottom: 15px;
}
.group-title {
    font-weight: bold;
    margin-bottom: 8px;
    font-size: 14px;
    color: #606266;
    border-bottom: 1px dashed #ebeef5;
    padding-bottom: 4px;
}
.group-items {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
}
.events-container {
    display: flex;
    flex-direction: column;
    width: 100%;
}
.all-events-checkbox {
    margin-bottom: 12px;
}
</style>
