<template>
  <div class="related-orders">
    <div class="section-header">
      <span class="section-title">关联订单</span>
      <el-badge :value="orders.length" type="info" />
    </div>

    <div v-if="orders.length === 0" class="empty-tip">暂无关联订单</div>

    <div
      v-for="order in orders"
      :key="order.id"
      class="order-card"
      :class="{
        [`border-${statusColor(order)}`]: true,
        'highlight': order.id === highlightOrderId,
      }"
      @click="$emit('orderClick', order.id)"
    >
      <div class="order-main">
        <div class="order-name">订单 #{{ order.id }}</div>
        <div class="order-meta">
          {{ order.symbol }} · {{ order.side }} · {{ order.type }}
        </div>
      </div>
      <div class="order-status">
        <el-tag :type="statusTagType(order)" size="small">{{ order.lifecycleStatus || order.status }}</el-tag>
        <div v-if="order.realizedPnl != null" class="pnl" :class="order.realizedPnl >= 0 ? 'positive' : 'negative'">
          {{ order.realizedPnl >= 0 ? '+' : '' }}{{ (order.realizedPnl * 100).toFixed(1) }}%
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RelatedOrder } from '../../types/strategy';

defineProps<{
  orders: RelatedOrder[];
  highlightOrderId?: number | null;
}>();

defineEmits<{
  orderClick: [orderId: number];
}>();

function statusColor(order: RelatedOrder): string {
  const status = order.lifecycleStatus || order.status;
  if (['filled', 'closed'].includes(status)) return 'success';
  if (['open', 'protected'].includes(status)) return 'warning';
  return 'danger';
}

function statusTagType(order: RelatedOrder): string {
  const color = statusColor(order);
  const map: Record<string, string> = { success: 'success', warning: 'warning', danger: 'danger' };
  return map[color] || 'info';
}
</script>

<style scoped>
.related-orders {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.section-title { font-weight: bold; font-size: 14px; }
.empty-tip { color: #999; font-size: 12px; text-align: center; padding: 12px 0; }
.order-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
  border-left: 3px solid #ddd;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.2s;
}
.order-card:hover { background: var(--el-fill-color); }
.order-card:last-child { margin-bottom: 0; }
.border-success { border-left-color: var(--el-color-success); }
.border-warning { border-left-color: var(--el-color-warning); }
.border-danger { border-left-color: var(--el-color-danger); }
.highlight { background: var(--el-color-primary-light-8); box-shadow: 0 0 0 1px var(--el-color-primary-light-5); }
.order-name { font-weight: bold; font-size: 12px; }
.order-meta { font-size: 11px; color: #666; margin-top: 2px; }
.order-status { text-align: right; }
.pnl { font-size: 11px; margin-top: 2px; }
.pnl.positive { color: var(--el-color-success); }
.pnl.negative { color: var(--el-color-danger); }
</style>
