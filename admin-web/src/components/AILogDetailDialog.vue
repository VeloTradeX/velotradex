<template>
  <el-dialog
    v-model="visible"
    title="解析日志详情"
    width="min(960px, 92vw)"
    top="4vh"
    class="log-detail-dialog"
  >
    <div v-if="log" class="log-detail">
      <div class="detail-actions">
        <el-button
          type="warning"
          :loading="isRetrying(log?.id)"
          @click="onRetry"
        >
          重新解析
        </el-button>
        <el-checkbox v-model="triggerOrder" label="同步触发订单" />
        <span class="detail-tip">默认只重新解析，不触发下单。勾选后重新解析成功将走完整下单流程。</span>
      </div>

      <div v-if="log.error" class="error-box">
        <strong>错误:</strong> {{ log.error }}
      </div>

      <div class="log-detail-grid">
        <section class="detail-section">
          <h3>基本信息</h3>
          <dl class="basic-info-list">
            <div>
              <dt>ID</dt>
              <dd>{{ log.id }}</dd>
            </div>
            <div>
              <dt>时间</dt>
              <dd>{{ formatDate(log.createdAt) }}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{{ log.model }}</dd>
            </div>
            <div>
              <dt>信号路由</dt>
              <dd>{{ formatRouteNames(log) }}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{{ formatDurationSec(log.durationMs) }}s</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{{ formatTokenCount(log.totalTokens ?? (log.promptTokens + log.completionTokens)) }}</dd>
            </div>
          </dl>
        </section>

        <section class="detail-section">
          <div class="detail-section-title-row">
            <h3>Response</h3>
            <el-segmented v-model="responseViewMode" :options="responseViewOptions" size="small" />
          </div>
          <div v-if="responseViewMode === 'summary'" class="response-summary">
            <template v-if="responseSummaryItems.length">
              <dl class="response-summary-list">
                <div v-for="item in responseSummaryItems" :key="item.label">
                  <dt>{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </div>
              </dl>
            </template>
            <pre v-else class="response-summary-text">{{ responseSummaryText }}</pre>
          </div>
          <el-input
            v-else
            type="textarea"
            :rows="12"
            :model-value="formatJsonForDisplay(log.response, 'No Response')"
            readonly
          />
        </section>

        <section v-if="hasOriginalMessage" class="detail-section">
          <h3>原始消息</h3>
          <div
            class="original-message-layout"
            :class="{
              'has-text': originalDiscordContent,
              'has-images': originalMessageImages.length
            }"
          >
            <el-input
              v-if="originalDiscordContent"
              type="textarea"
              :rows="8"
              :model-value="originalDiscordContent"
              readonly
            />
            <div v-if="originalMessageImages.length" class="original-message-attachments">
              <el-image
                v-for="(image, index) in originalMessageImages"
                :key="`${image}-${index}`"
                :src="image"
                :preview-src-list="originalMessageImages"
                :initial-index="index"
                preview-teleported
                fit="contain"
                class="original-message-image"
              />
            </div>
          </div>
        </section>

        <el-collapse v-model="promptCollapseActive" class="detail-collapse">
          <el-collapse-item v-if="log.systemPrompt" title="System Prompt" name="systemPrompt">
            <el-input type="textarea" :rows="10" :model-value="log.systemPrompt" readonly />
          </el-collapse-item>

          <el-collapse-item title="Prompt" name="prompt">
            <el-input type="textarea" :rows="14" :model-value="log.prompt" readonly />
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  formatRouteNames,
  formatJsonForDisplay,
  getOriginalMessageParts,
  formatSummaryValue,
  getResponseSummarySource
} from '../utils/aiLog'
import { isRetrying } from '../composables/useAiLogRetry'
import { formatDate, formatTokenCount, formatDurationSec } from '../utils/format'

const visible = defineModel<boolean>({ required: true })
const props = defineProps<{ log: any }>()
const emit = defineEmits<{ retry: [triggerOrder: boolean] }>()

const triggerOrder = ref(false)
const responseViewStorageKey = 'ai-log-response-view-mode'
const savedResponseViewMode = localStorage.getItem(responseViewStorageKey)
const responseViewMode = ref(savedResponseViewMode === 'summary' ? 'summary' : 'raw')
const responseViewOptions = [
  { label: '节省', value: 'raw' },
  { label: '概览', value: 'summary' }
]
const promptCollapseActive = ref<string[]>([])

const originalDiscordContent = computed(() => getOriginalMessageParts(props.log).content)
const originalMessageImages = computed(() => getOriginalMessageParts(props.log).images)
const hasOriginalMessage = computed(() => Boolean(originalDiscordContent.value || originalMessageImages.value.length))

const responseSummaryItems = computed(() => {
  const parsed = getResponseSummarySource(props.log?.response)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []

  const response = parsed as Record<string, unknown>
  const preferredFields = [
    ['策略', 'action'],
    ['交易对', 'symbol'],
    ['方向', 'side'],
    ['入场价', 'entryPrice'],
    ['目标价', 'targets'],
    ['止损', 'stopLoss'],
    ['杠杆', 'leverage'],
    ['置信度', 'confidence'],
    ['原因', 'reasoning']
  ] as const

  const items = preferredFields
    .filter(([, key]) => response[key] !== undefined && response[key] !== null && response[key] !== '')
    .map(([label, key]) => ({ label, value: formatSummaryValue(response[key]) }))

  if (items.length) return items

  return Object.entries(response).map(([label, value]) => ({
    label,
    value: formatSummaryValue(value)
  }))
})

const responseSummaryText = computed(() => formatJsonForDisplay(props.log?.response, 'No Response'))

watch(responseViewMode, (mode) => {
  localStorage.setItem(responseViewStorageKey, mode)
})

// 每次打开/刷新日志时，重置折叠面板与「同步触发订单」勾选，等价于原 retryLog/viewLogDetail 中的重置逻辑。
watch(
  () => props.log,
  () => {
    promptCollapseActive.value = []
    triggerOrder.value = false
  }
)

const onRetry = () => {
  emit('retry', triggerOrder.value)
}
</script>

<style scoped>
.log-detail-dialog :deep(.el-dialog__body) {
    max-height: 82vh;
    overflow: auto;
}
.log-detail {
    min-width: 0;
}
.log-detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    align-items: start;
}
.detail-section {
    min-width: 0;
}
.log-detail h3 {
    margin-top: 0;
    margin-bottom: 10px;
    font-size: 16px;
    border-bottom: 1px solid #eee;
    padding-bottom: 5px;
}
.detail-section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid #eee;
    margin-bottom: 10px;
    padding-bottom: 5px;
}
.detail-section-title-row h3 {
    margin-bottom: 0;
    border-bottom: 0;
    padding-bottom: 0;
}
.basic-info-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 0;
}
.basic-info-list div {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 10px;
}
.basic-info-list dt {
    color: #606266;
    font-weight: 600;
}
.basic-info-list dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
}
.response-summary {
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    background: #fafafa;
    padding: 12px;
}
.response-summary-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    margin: 0;
}
.response-summary-list div {
    min-width: 0;
}
.response-summary-list dt {
    color: #606266;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
}
.response-summary-list dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}
.response-summary-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: inherit;
}
.detail-collapse {
    min-width: 0;
}
.detail-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
}
.detail-tip {
    font-size: 12px;
    color: #909399;
}
.error-box {
    color: #f56c6c;
    background: #fef0f0;
    padding: 10px;
    border-radius: 4px;
    margin-top: 10px;
}
.original-message-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    align-items: start;
}
.original-message-layout.has-text.has-images {
    grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
}
.original-message-attachments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
    min-width: 0;
}
.original-message-image {
    width: 100%;
    height: 160px;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    background: #fafafa;
    cursor: zoom-in;
}
.original-message-image :deep(.el-image__inner) {
    width: 100%;
    height: 100%;
    object-fit: contain;
}
@media (max-width: 900px) {
    .basic-info-list,
    .response-summary-list,
    .original-message-layout.has-text.has-images {
        grid-template-columns: 1fr;
    }
}
@media (max-width: 560px) {
    .detail-section-title-row {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>
