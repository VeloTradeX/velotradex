<template>
  <div class="audit-timeline">
    <div class="section-title">审计链</div>

    <div v-if="auditLogs.length === 0" class="empty-tip">暂无审计记录</div>

    <div class="timeline">
      <div
        v-for="log in auditLogs"
        :key="log.id"
        :id="`audit-log-${log.id}`"
        class="timeline-item"
        :class="{ 'highlight': isHighlightLog(log) }"
      >
        <div class="timeline-dot" :class="`dot-${getDotColor(log)}`"></div>
        <div class="timeline-content">
          <div class="timeline-action" :class="`text-${getDotColor(log)}`">
            {{ formatAction(log.action) }}
          </div>
          <div class="timeline-time">{{ formatDate(log.createdAt) }}</div>
          <div class="timeline-detail">{{ formatDetails(log.details) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AuditLogEntry } from '../../types/strategy';
import { formatAction, formatDetails } from '../../utils/auditFormatters'
import { formatDate } from '../../utils/format';

const props = defineProps<{
  auditLogs: AuditLogEntry[];
  highlightOrderId?: number | null;
}>();

function getDotColor(log: AuditLogEntry): string {
  if (log.action.includes('fail') || log.action.includes('error') || log.action.includes('reject')) return 'danger';
  if (log.action.includes('create') || log.action.includes('fill') || log.action.includes('close') || log.action.includes('success')) return 'success';
  if (log.action.includes('route') || log.action.includes('execute')) return 'warning';
  return 'primary';
}

function isHighlightLog(log: AuditLogEntry): boolean {
  return props.highlightOrderId != null && log.orderId === props.highlightOrderId;
}

</script>

<style scoped>
.audit-timeline {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px;
}
.section-title { font-weight: bold; font-size: 14px; margin-bottom: 8px; }
.empty-tip { color: #999; font-size: 12px; text-align: center; padding: 12px 0; }
.timeline {
  position: relative;
  padding-left: 20px;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: #ddd;
}
.timeline-item {
  position: relative;
  margin-bottom: 12px;
  padding: 4px 0;
  border-radius: 4px;
  transition: background 0.2s;
}
.timeline-item:last-child { margin-bottom: 0; }
.timeline-item.highlight { background: var(--el-color-primary-light-8); }
.timeline-dot {
  position: absolute;
  left: -17px;
  top: 6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
}
.dot-primary { background: var(--el-color-primary); }
.dot-success { background: var(--el-color-success); }
.dot-warning { background: var(--el-color-warning); }
.dot-danger { background: var(--el-color-danger); }
.timeline-action { font-size: 12px; font-weight: bold; }
.text-primary { color: var(--el-color-primary); }
.text-success { color: var(--el-color-success); }
.text-warning { color: var(--el-color-warning); }
.text-danger { color: var(--el-color-danger); }
.timeline-time { font-size: 11px; color: #999; }
.timeline-detail { font-size: 11px; color: #666; margin-top: 2px; }
</style>
