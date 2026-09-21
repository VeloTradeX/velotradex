<template>
  <el-dialog
    v-model="visible"
    title="日志详情"
    width="800px"
    class="log-details-dialog"
  >
    <div v-if="log" class="log-details-content">
      <div class="detail-row">
        <span class="label">时间:</span>
        <span>{{ log.timestamp }}</span>
      </div>
      <div class="detail-row">
        <span class="label">级别:</span>
        <el-tag :type="getLevelType(log.level)">{{ log.level.toUpperCase() }}</el-tag>
      </div>
      <div class="detail-row" v-if="log.traceId">
        <span class="label">Trace ID:</span>
        <span>{{ log.traceId }}</span>
      </div>
      <div class="detail-row">
        <span class="label">消息:</span>
        <span>{{ log.message }}</span>
      </div>

      <div class="json-viewer">
        <pre>{{ formatJson(log) }}</pre>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getLevelType } from '../utils/log'

const props = defineProps<{
  modelValue: boolean
  log: any | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const formatJson = (log: any) => {
  // Exclude basic fields from the JSON dump if desired, or show full object
  return JSON.stringify(log, null, 2)
}
</script>

<style scoped>
.log-details-content {
  padding: 10px;
}

.detail-row {
  margin-bottom: 10px;
  display: flex;
}

.detail-row .label {
  width: 80px;
  font-weight: bold;
  color: #a0a0a0;
}

.json-viewer {
  margin-top: 20px;
  background-color: #0d0d0d;
  padding: 15px;
  border-radius: 4px;
  overflow-x: auto;
}

.json-viewer pre {
  margin: 0;
  font-family: 'Fira Code', monospace;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
