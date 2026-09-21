<template>
  <el-drawer
    v-model="visible"
    title="信号详情"
    size="680px"
    :before-close="handleClose"
  >
    <div v-if="loading" class="drawer-loading">
      <el-skeleton :rows="8" animated />
    </div>
    <div v-else-if="error" class="drawer-error">
      <el-alert :title="error" type="error" :closable="false" />
    </div>
    <div v-else-if="data" class="drawer-content">
      <SignalOverview :strategy="data.strategy" />
      <RelatedOrders
        :orders="data.orders"
        :highlight-order-id="orderId"
        @order-click="scrollToAuditLog"
      />
      <AuditTimeline
        :audit-logs="data.auditLogs"
        :highlight-order-id="orderId"
      />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useStrategyDetail } from '../../composables/useStrategyDetail';
import SignalOverview from './SignalOverview.vue';
import RelatedOrders from './RelatedOrders.vue';
import AuditTimeline from './AuditTimeline.vue';

const props = defineProps<{
  strategyId: number | null;
  orderId?: number | null;
}>();

const visible = defineModel<boolean>('visible', { default: false });

const { loading, error, data, fetchDetail, reset } = useStrategyDetail();

watch(visible, (val) => {
  if (val && props.strategyId) {
    fetchDetail(props.strategyId);
  } else if (!val) {
    reset();
  }
});

function handleClose() {
  visible.value = false;
}

function scrollToAuditLog(orderId: number) {
  if (!data.value) return;
  const targetLog = data.value.auditLogs.find(log => log.orderId === orderId);
  if (targetLog) {
    const el = document.getElementById(`audit-log-${targetLog.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
</script>

<style scoped>
.drawer-loading, .drawer-error { padding: 20px; }
.drawer-content { padding: 0 16px; }
</style>
