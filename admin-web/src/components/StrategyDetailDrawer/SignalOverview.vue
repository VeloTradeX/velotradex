<template>
  <div class="signal-overview">
    <div class="signal-header">
      <span class="signal-id">信号 #{{ strategy.id }}</span>
      <div class="signal-tags">
        <el-tag :type="actionTagType" size="small">{{ strategy.action }}</el-tag>
        <el-tag :type="sideTagType" size="small">{{ strategy.side }}</el-tag>
      </div>
    </div>

    <div class="signal-grid">
      <div class="grid-item">
        <span class="label">交易对</span>
        <span class="value">{{ strategy.symbol }}</span>
      </div>
      <div class="grid-item">
        <span class="label">解析器</span>
        <span class="value">{{ strategy.parserName }}</span>
      </div>
      <div class="grid-item">
        <span class="label">来源</span>
        <span class="value">{{ strategy.source }}</span>
      </div>
      <div class="grid-item">
        <span class="label">入场价</span>
        <span class="value">{{ strategy.entryPrice ?? '—' }}</span>
      </div>
      <div class="grid-item">
        <span class="label">止损</span>
        <span class="value">{{ strategy.stopLoss ?? '—' }}</span>
      </div>
      <div class="grid-item">
        <span class="label">目标</span>
        <span class="value">{{ formatTargets(strategy.targets) }}</span>
      </div>
    </div>

    <div class="raw-message">
      <div class="label" @click="showRawMessage = !showRawMessage">
        原始消息
        <el-icon><ArrowDown v-if="!showRawMessage" /><ArrowUp v-else /></el-icon>
      </div>
      <div v-if="showRawMessage" class="message-content">
        <pre>{{ strategy.rawMessage }}</pre>
        <el-button size="small" text @click="copyMessage">复制</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue';
import type { StrategyDetail } from '../../types/strategy';

const props = defineProps<{
  strategy: StrategyDetail;
}>();

const showRawMessage = ref(false);

const actionTagType = computed(() => {
  const map: Record<string, string> = { open: 'success', close: 'danger' };
  return map[props.strategy.action] || 'info';
});

const sideTagType = computed(() => {
  const map: Record<string, string> = { buy: 'success', sell: 'danger' };
  return map[props.strategy.side] || 'info';
});

function formatTargets(targets: string | undefined): string {
  if (!targets) return '—';
  try {
    const parsed = JSON.parse(targets);
    if (!Array.isArray(parsed) || parsed.length === 0) return '—';
    return parsed.join(' / ');
  } catch {
    return targets;
  }
}

async function copyMessage() {
  await navigator.clipboard.writeText(props.strategy.rawMessage);
}
</script>

<style scoped>
.signal-overview {
  padding: 12px;
  border: 2px solid var(--el-color-primary);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  margin-bottom: 12px;
}
.signal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.signal-id { font-weight: bold; font-size: 15px; }
.signal-tags { display: flex; gap: 6px; }
.signal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  font-size: 12px;
}
.grid-item .label { color: #999; display: block; }
.grid-item .value { font-weight: bold; }
.raw-message {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #ccc;
}
.raw-message .label {
  color: #999;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.message-content {
  margin-top: 4px;
  background: white;
  padding: 6px;
  border-radius: 4px;
  position: relative;
}
.message-content pre {
  font-size: 11px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
}
.message-content .el-button {
  position: absolute;
  top: 2px;
  right: 2px;
}
</style>
