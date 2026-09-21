<template>
  <span class="exchange-logo" :class="sizeClass" :style="rootStyle">
    <i :class="iconClass" :style="iconStyle" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type ExchangeType = 'gate' | 'gate_tradfi' | 'lighter' | 'binance' | 'virtual_gate' | 'virtual_gate_tradfi'

const props = withDefaults(defineProps<{
  /** 交易所类型 */
  type: ExchangeType | (string & {})
  /** 预设尺寸或自定义像素值 */
  size?: 'xs' | 'sm' | 'md' | 'lg' | number
}>(), {
  size: 'sm'
})

/**
 * 图标映射（按用户要求）
 * gate, gate_tradfi → 共用 gate_io（颜色区分）
 * lighter → mark-listing
 * binance → binance
 * virtual_gate → demo（对应 class 是 icon-icon01）
 * virtual_gate_tradfi → gate_io（TradFi 图标）+ 虚拟色（与虚拟 Gate 区分）
 */
const typeToIconClass: Record<string, string> = {
  gate: 'iconfont icon-gate_io',
  gate_tradfi: 'iconfont icon-gate_io',
  lighter: 'iconfont icon-mark-listing',
  binance: 'iconfont icon-binance',
  virtual_gate: 'iconfont icon-icon01',
  virtual_gate_tradfi: 'iconfont icon-gate_io'
}

/**
 * 品牌色值（让灰白字体图标有对应的品牌颜色）
 *  - gate: Gate 官方绿
 *  - gate_tradfi: TradFi 金融蓝（和 gate 同图标，但颜色区分）
 *  - lighter: Lighter 橙红火焰色
 *  - binance: 币安黄
 *  - virtual_gate: 沙盒紫（虚拟感）
 *  - virtual_gate_tradfi: TradFi 金融蓝 + 虚拟感（取介于二之间的青色，示意模拟盘）
 */
// 颜色来源：iconfont.js 中 SVG path 的原始 fill 属性
const typeToColor: Record<string, string> = {
  gate: '#2354E6',
  gate_tradfi: '#2354E6',
  lighter: '#000000',
  binance: '#F3BA2F',
  virtual_gate: '#F5B925',
  virtual_gate_tradfi: '#12B886'
}

const sizeMap: Record<string, number> = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24
}

const pixelSize = computed(() => {
  if (typeof props.size === 'number') return props.size
  return sizeMap[props.size as string] ?? sizeMap.sm
})

const sizeClass = computed(() => {
  if (typeof props.size === 'string' && sizeMap[props.size]) {
    return `is-${props.size}`
  }
  return ''
})

const rootStyle = computed(() => {
  const style: Record<string, string> = {
    width: `${pixelSize.value}px`,
    height: `${pixelSize.value}px`
  }
  // Lighter 使用原始黑色图标
  // （无特殊背景，透明即可）
  return style
})

const iconClass = computed(() => typeToIconClass[props.type as string] || 'iconfont')

const iconStyle = computed(() => ({
  color: typeToColor[props.type as string] || '#777',
  fontSize: `${pixelSize.value}px`,
  lineHeight: `${pixelSize.value}px`
}))
</script>

<style scoped>
.exchange-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
