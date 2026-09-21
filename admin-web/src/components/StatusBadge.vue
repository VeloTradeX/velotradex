<script setup lang="ts">
/**
 * StatusBadge —— 全站统一的状态/方向/类型胶囊徽标（标杆组件）
 *
 * 以「图标 + 语义色 + 文本」的方式直观呈现表格中的枚举类字段，
 * 例如买卖方向、开平仓动作、订单状态、日志级别、HTTP 方法等。
 *
 * 用法示例：
 *   <StatusBadge :value="row.side" kind="side" />
 *   <StatusBadge :value="row.status" kind="status" size="small" />
 *   <StatusBadge :value="row.isActive" />
 *   <StatusBadge :value="row.aiMode" kind="mode" />
 *
 * 设计约定：
 * - 颜色使用 CSS 变量（--color-success / --el-color-success 等），自动适配浅色/深色主题；
 * - 文本默认展示原始值（不改变信息语义），可通过 label 覆盖；
 * - 未知枚举值走关键词兜底推断，避免出现整列灰白、无法区分的情况。
 */
import { computed } from 'vue'
import { ElIcon } from 'element-plus'
import {
  ArrowDown, ArrowUp, Bottom, ChatDotRound, CircleCheck, CircleClose,
  CirclePlus, Clock, Close, Connection, Delete, Edit, Filter, InfoFilled,
  Minus, Plus, Position, Search, Top, TrendCharts, UserFilled, VideoPlay,
  View, Warning,
} from '@element-plus/icons-vue'

type Tone = 'success' | 'danger' | 'warning' | 'info' | 'primary'
type Kind = 'side' | 'action' | 'status' | 'role' | 'level' | 'method' | 'mode' | 'http' | 'generic'

const props = withDefaults(defineProps<{
  value: string | number | boolean | null | undefined
  kind?: Kind
  size?: 'small' | 'default'
  /** 覆盖显示文本；不传时展示原始值 */
  label?: string
}>(), {
  kind: 'generic',
  size: 'default',
})

interface Entry {
  icon?: any
  tone: Tone
  label?: string
}

const raw = computed(() => String(props.value ?? '').trim().toLowerCase())

/* ---------------- 语义映射表 ---------------- */

const SIDE: Record<string, Entry> = {
  buy: { icon: ArrowUp, tone: 'success' },
  sell: { icon: ArrowDown, tone: 'danger' },
  long: { icon: TrendCharts, tone: 'success' },
  short: { icon: Bottom, tone: 'danger' },
}

const ACTION: Record<string, Entry> = {
  open: { icon: CirclePlus, tone: 'success' },
  long: { icon: CirclePlus, tone: 'success' },
  close: { icon: CircleClose, tone: 'danger' },
  short: { icon: CircleClose, tone: 'danger' },
  update: { icon: Edit, tone: 'primary' },
  cancel: { icon: Close, tone: 'warning' },
  ignore: { icon: InfoFilled, tone: 'info' },
  add: { icon: Plus, tone: 'success' },
  reduce: { icon: Minus, tone: 'warning' },
}

const STATUS: Record<string, Entry> = {
  // 成功 / 进行中(正向)
  filled: { icon: CircleCheck, tone: 'success' },
  finished: { icon: CircleCheck, tone: 'success' },
  executed: { icon: CircleCheck, tone: 'success' },
  processed: { icon: CircleCheck, tone: 'success' },
  success: { icon: CircleCheck, tone: 'success' },
  succeeded: { icon: CircleCheck, tone: 'success' },
  completed: { icon: CircleCheck, tone: 'success' },
  done: { icon: CircleCheck, tone: 'success' },
  ok: { icon: CircleCheck, tone: 'success' },
  active: { icon: VideoPlay, tone: 'success' },
  enabled: { icon: VideoPlay, tone: 'success' },
  connected: { icon: Connection, tone: 'success' },
  online: { icon: VideoPlay, tone: 'success' },
  running: { icon: VideoPlay, tone: 'success' },
  true: { icon: CircleCheck, tone: 'success' },
  // 失败 / 停止(负向)
  failed: { icon: CircleClose, tone: 'danger' },
  error: { icon: CircleClose, tone: 'danger' },
  canceled: { icon: CircleClose, tone: 'danger' },
  cancelled: { icon: CircleClose, tone: 'danger' },
  rejected: { icon: CircleClose, tone: 'danger' },
  expired: { icon: CircleClose, tone: 'danger' },
  disabled: { icon: CircleClose, tone: 'danger' },
  disconnected: { icon: CircleClose, tone: 'danger' },
  inactive: { icon: CircleClose, tone: 'danger' },
  offline: { icon: CircleClose, tone: 'danger' },
  false: { icon: CircleClose, tone: 'danger' },
  // 挂单 / 等待 / 中间态
  open: { icon: Clock, tone: 'warning' },
  pending: { icon: Clock, tone: 'warning' },
  new: { icon: Clock, tone: 'warning' },
  waiting: { icon: Clock, tone: 'warning' },
  queued: { icon: Clock, tone: 'warning' },
  partial: { icon: Warning, tone: 'warning' },
  partially_filled: { icon: Warning, tone: 'warning' },
  closed: { icon: Warning, tone: 'warning' },
  // 其他
  filtered: { icon: Filter, tone: 'info' },
}

const ROLE: Record<string, Entry> = {
  entry: { icon: Position, tone: 'primary' },
  tp: { icon: Top, tone: 'success' },
  take_profit: { icon: Top, tone: 'success' },
  sl: { icon: Bottom, tone: 'danger' },
  stop_loss: { icon: Bottom, tone: 'danger' },
  close: { icon: CircleClose, tone: 'warning' },
  admin: { icon: UserFilled, tone: 'danger' },
  viewer: { icon: View, tone: 'info' },
}

const LEVEL: Record<string, Entry> = {
  debug: { icon: InfoFilled, tone: 'info' },
  info: { icon: InfoFilled, tone: 'info' },
  warn: { icon: Warning, tone: 'warning' },
  warning: { icon: Warning, tone: 'warning' },
  error: { icon: CircleClose, tone: 'danger' },
  fatal: { icon: CircleClose, tone: 'danger' },
}

const METHOD: Record<string, Entry> = {
  get: { icon: Search, tone: 'info' },
  post: { icon: Plus, tone: 'success' },
  put: { icon: Edit, tone: 'warning' },
  patch: { icon: Edit, tone: 'warning' },
  delete: { icon: Delete, tone: 'danger' },
}

const MODE: Record<string, Entry> = {
  enabled: { icon: VideoPlay, tone: 'success', label: '启用' },
  analyze_only: { icon: View, tone: 'warning', label: '仅分析' },
  disabled: { icon: CircleClose, tone: 'danger', label: '禁用' },
  real: { icon: VideoPlay, tone: 'danger', label: '实盘' },
  testnet: { icon: Warning, tone: 'warning', label: '测试网' },
  observe: { icon: View, tone: 'info', label: '观察' },
}

const GENERIC: Record<string, Entry> = {
  // Webhook 类型
  webhook: { icon: ChatDotRound, tone: 'info' },
  feishu: { icon: ChatDotRound, tone: 'primary' },
  dingtalk: { icon: ChatDotRound, tone: 'warning' },
  pushover: { icon: ChatDotRound, tone: 'danger' },
  // 交易所类型
  gate: { tone: 'info' },
  gate_tradfi: { tone: 'warning' },
  binance: { tone: 'primary' },
  lighter: { tone: 'danger' },
  virtual_gate: { tone: 'info' },
  // 订单类型
  limit: { tone: 'info' },
  market: { tone: 'primary' },
  take_profit: { icon: Top, tone: 'success' },
  stop_loss: { icon: Bottom, tone: 'danger' },
  trigger: { icon: Clock, tone: 'warning' },
  // 交易所连接状态
  connected: { icon: Connection, tone: 'success' },
  disconnected: { icon: CircleClose, tone: 'danger' },
}

/* ---------------- 兜底推断 ---------------- */

function infer(rawValue: string): Entry {
  if (/fill|success|succeed|done|complete|execut|process|active|enable|connect|online|running|^ok$/.test(rawValue)) {
    return { icon: CircleCheck, tone: 'success' }
  }
  if (/fail|error|cancel|reject|expire|disabl|disconnect|offline|denied|banned/.test(rawValue)) {
    return { icon: CircleClose, tone: 'danger' }
  }
  if (/open|pend|warn|partial|wait|queue|trigger/.test(rawValue)) {
    return { icon: Clock, tone: 'warning' }
  }
  if (/filter|skip|ignore/.test(rawValue)) {
    return { icon: Filter, tone: 'info' }
  }
  return { icon: InfoFilled, tone: 'info' }
}

/* ---------------- 计算属性 ---------------- */

function resolveHttp(rawValue: string): Entry {
  const code = Number(rawValue)
  if (!Number.isNaN(code)) {
    if (code >= 500) return { icon: CircleClose, tone: 'danger' }
    if (code >= 400) return { icon: CircleClose, tone: 'warning' }
    if (code >= 300) return { icon: Warning, tone: 'warning' }
    if (code >= 200) return { icon: CircleCheck, tone: 'success' }
  }
  return { icon: InfoFilled, tone: 'info' }
}

const entry = computed<Entry>(() => {
  const v = raw.value
  if (!v) return { icon: InfoFilled, tone: 'info' }
  switch (props.kind) {
    case 'side': return SIDE[v] || infer(v)
    case 'action': return ACTION[v] || infer(v)
    case 'status': return STATUS[v] || infer(v)
    case 'role': return ROLE[v] || infer(v)
    case 'level': return LEVEL[v] || infer(v)
    case 'method': return METHOD[v] || infer(v)
    case 'mode': return MODE[v] || infer(v)
    case 'http': return resolveHttp(v)
    default: return GENERIC[v] || infer(v)
  }
})

const toneClass = computed(() => `status-badge--${entry.value.tone}`)
const sizeClass = computed(() => (props.size === 'small' ? 'is-small' : ''))
const displayLabel = computed(() => props.label ?? entry.value.label ?? String(props.value ?? '-'))
const iconComponent = computed(() => entry.value.icon || InfoFilled)
</script>

<template>
  <span class="status-badge" :class="[toneClass, sizeClass]">
    <el-icon class="status-badge__icon"><component :is="iconComponent" /></el-icon>
    <span class="status-badge__label">{{ displayLabel }}</span>
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  box-sizing: border-box;
  vertical-align: middle;
}

.status-badge.is-small {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  gap: 3px;
}

.status-badge__icon {
  font-size: 12px;
  flex-shrink: 0;
}

.status-badge.is-small .status-badge__icon {
  font-size: 11px;
}

/* 语义色：优先使用项目自定义变量，浅色主题回退到 Element Plus 语义色 */
.status-badge--success {
  --badge-color: var(--color-success, var(--el-color-success));
}
.status-badge--danger {
  --badge-color: var(--color-danger, var(--el-color-danger));
}
.status-badge--warning {
  --badge-color: var(--color-warning, var(--el-color-warning));
}
.status-badge--info {
  --badge-color: var(--el-color-info);
}
.status-badge--primary {
  --badge-color: var(--color-primary-start, var(--el-color-primary));
}

.status-badge {
  color: var(--badge-color);
  background-color: rgba(144, 147, 153, 0.10);
  background-color: color-mix(in srgb, var(--badge-color) 12%, transparent);
  border-color: color-mix(in srgb, var(--badge-color) 26%, transparent);
}
</style>
