<template>
  <div>
    <!-- Overview Mode: Grid Layout (Left->Right, Top->Bottom) -->
    <div v-if="viewMode === 'overview'" class="audit-log-grid-container">
      <!-- Step 1: Start -->
      <div class="flow-start-marker">
        <div class="marker-dot"></div>
        <div class="marker-line"></div>
      </div>

      <div class="audit-log-grid">
        <el-card v-for="(log, index) in logs" :key="index" shadow="hover"
          class="audit-log-card">
          <!-- Flow connector line -->
          <div class="card-connector-line" v-if="index < logs.length - 1">
          </div>

          <div class="log-header">
            <span class="log-index">#{{ index + 1 }}</span>
            <el-tag size="small" :type="getTimelineType(log.action)" effect="light">{{
              formatAction(log.action) }}</el-tag>
          </div>
          <div class="log-time-row">
            {{ formatDate(log.createdAt) }}
          </div>
          <div class="log-content">
            <div v-for="(item, idx) in getSummaryFields(log.action, log.details)" :key="idx"
              class="log-field">
              <span class="field-label">{{ item.label }}:</span>
              <span class="field-value">{{ item.value }}</span>
            </div>
            <div v-if="getSummaryFields(log.action, log.details).length === 0" class="no-info">
              无关键信息
            </div>
          </div>
        </el-card>
      </div>

      <!-- Step N: End -->
      <div class="flow-end-marker">
        <div class="marker-line"></div>
        <div class="marker-dot end"></div>
      </div>
    </div>

    <!-- Details Mode: Timeline Layout -->
    <el-timeline v-else>
      <el-timeline-item v-for="(log, index) in logs" :key="index"
        :timestamp="formatDate(log.createdAt)" :type="getTimelineType(log.action)"
        placement="top">
        <el-card shadow="never" style="border: 1px solid #ebeef5;">
          <h4 style="margin: 0 0 10px 0;">{{ formatAction(log.action) }}</h4>
          <pre class="json-details">{{ formatDetails(log.details) }}</pre>
        </el-card>
      </el-timeline-item>
    </el-timeline>
  </div>
</template>

<script setup lang="ts">
import { formatAction, getTimelineType, formatDetails } from '../utils/auditFormatters'
import { formatDate } from '../utils/format'

const props = defineProps<{
  logs: any[]
  viewMode: string
}>()

const getSummaryFields = (action: string, details: string | object) => {
  let data: any = details
  if (typeof details === 'string') {
    try {
      data = JSON.parse(details)
    } catch (e) {
      return [{ label: 'Content', value: String(details) }]
    }
  }
  if (!data || typeof data !== 'object') return []

  const fields: { label: string, value: string }[] = []

  // Helper to add if exists
  const add = (key: string, label: string) => {
    if (data[key] !== undefined && data[key] !== null) {
      fields.push({ label, value: String(data[key]) })
    }
  }

  if (action === 'STRATEGY_CREATED') {
    // Handle nested parsed object if available (e.g. from app.ts auditService.log)
    const info = data.parsed || data

    if (info.symbol) fields.push({ label: 'Symbol', value: String(info.symbol) })
    if (info.side) fields.push({ label: 'Side', value: String(info.side) })
    if (info.stopLoss) fields.push({ label: 'SL', value: String(info.stopLoss) })

    // Handle TP (targets array or takeProfit value)
    if (info.targets && Array.isArray(info.targets) && info.targets.length > 0) {
      fields.push({ label: 'TP', value: info.targets.join(', ') })
    } else if (info.takeProfit) {
      fields.push({ label: 'TP', value: String(info.takeProfit) })
    }

    return fields // Return all found fields (ignore slice limit)
  } else if (action === 'EXECUTING') {
    add('action', 'Action')
    add('symbol', 'Symbol')
  } else if (action === 'ORDER_INIT' || action === 'ORDER_CREATED') {
    add('price', 'Price')
    add('amount', 'Amount')
    add('side', 'Side')
    add('leverage', 'Lev')
  } else if (action.includes('FILLED')) {
    // For filled events, we might have filledPrice/Amount or price/amount
    if (data.filledPrice) add('filledPrice', 'Filled Price')
    else add('price', 'Price')

    if (data.filledAmount) add('filledAmount', 'Filled Amount')
    else add('amount', 'Amount')
  } else if (action === 'PLACING_PROTECTION') {
    add('stopLoss', 'SL')
    add('takeProfit', 'TP')
  } else if (action === 'TP_ORDER_PLACED') {
    add('index', 'Index')
    add('price', 'Price')
    add('amount', 'Amount')
  } else if (action === 'SUBMITTING_CLOSE_ORDER') {
    add('symbol', 'Symbol')
    add('side', 'Side')
    add('amount', 'Amount') // Partial?
  } else if (action === 'ORDER_CLOSED_POSITION') {
    add('orderId', 'Order ID')
  } else {
    // Default Fallback: Try common fields
    if (fields.length === 0) {
      if (data.symbol) add('symbol', 'Symbol')
      if (data.price) add('price', 'Price')
      if (data.amount) add('amount', 'Amount')
      if (data.status) add('status', 'Status')
      if (data.error) add('error', 'Error')
    }
  }

  // Limit to 3
  return fields.slice(0, 3)
}
</script>

<style scoped>
/* Timeline and other styles */
.audit-log-grid-container {
  display: flex;
  flex-direction: column;
  position: relative;
  padding-left: 30px;
}

.audit-log-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 10px;
}

.audit-log-card {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: visible;
  /* Allow connector to be visible */
  border-radius: 8px;
  transition: all 0.3s;
}

.audit-log-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 5px;
}

.log-index {
  font-weight: bold;
  color: #909399;
  font-size: 14px;
  background: #f4f4f5;
  padding: 2px 6px;
  border-radius: 4px;
}

.log-time-row {
  font-size: 11px;
  color: #999;
  margin-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
  padding-bottom: 5px;
}

/* Flow Visuals */
.card-connector-line {
  position: absolute;
  right: -20px;
  /* Extend into gap */
  top: 50%;
  width: 20px;
  height: 2px;
  background-color: #dcdfe6;
  z-index: 1;
}

/* Hide connector for last item in row (3rd, 6th, etc) and handle wrap around? */
/* CSS Grid wrap around connectors are tricky without SVG.
   Simplification: Just show index numbers clearly to guide flow.
   Or arrows?
   Let's use a subtle arrow on the right of each card, except the very last one.
*/
.card-connector-line {
  display: none;
  /* Removed physical line connector as it's hard in grid wrap */
}

/* Use pseudo-element for arrow on the right side of card */
.audit-log-card::after {
  content: "→";
  position: absolute;
  right: -18px;
  top: 50%;
  transform: translateY(-50%);
  color: #dcdfe6;
  font-size: 20px;
  font-weight: bold;
}

/* Remove arrow for every 3rd item (end of row) to suggest wrap?
   Actually, standard reading order is Z-pattern. Arrow right is fine.
   But for the last item in a row, the next item is below-left.
   Let's just keep simple arrows for flow guidance.
*/
.audit-log-card:nth-child(3n)::after {
  content: "↴";
  /* Down-left arrow suggestion? Or just hide */
  right: -10px;
  bottom: -10px;
  top: auto;
  transform: none;
  display: none;
  /* Hide for now, clean grid is better */
}

.audit-log-card:last-child::after {
  display: none;
  /* No arrow for final card */
}

/* Start/End Markers */
.flow-start-marker {
  display: none;
  /* Simplified */
}

.flow-end-marker {
  display: none;
  /* Simplified */
}

/* Reuse existing styles */
.log-content {
  font-size: 13px;
  color: #606266;
}

.log-field {
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
}

.field-label {
  font-weight: bold;
  color: #303133;
  margin-right: 5px;
}

.field-value {
  word-break: break-all;
  text-align: right;
  flex: 1;
}

.no-info {
  color: #ccc;
  font-style: italic;
  font-size: 12px;
  text-align: center;
  margin-top: 5px;
}

.json-details {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 12px;
  color: #666;
  background: #fff;
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #eee;
  margin: 0;
}
</style>
