<template>
  <div class="trading-stats">
    <div class="header">
      <div class="filters"></div>
      <el-button @click="fetchStats" :icon="Refresh" circle />
    </div>

    <div v-loading="loading">
      <div v-if="currentStats" class="source-section">
        <!-- Group: 收益 -->
        <el-card class="kpi-card" shadow="never">
          <div class="kpi-group-title">收益</div>
          <div class="kpi-grid">
            <el-statistic :value="currentStats.totalPnL" :precision="2" prefix="$">
              <template #title>
                <div class="metric-title">
                  <span>总盈亏 (Total PnL)</span>
                  <el-tooltip :content="metricTips.totalPnL" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value" :class="value >= 0 ? 'text-success' : 'text-danger'">{{ value }}</span>
              </template>
            </el-statistic>
            <el-statistic :value="currentStats.totalFees" :precision="2" prefix="$">
              <template #title>
                <div class="metric-title">
                  <span>总手续费 (Total Fee)</span>
                  <el-tooltip :content="metricTips.totalFees" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
            <el-statistic :value="currentStats.totalRoi" :precision="2" suffix="%">
              <template #title>
                <div class="metric-title">
                  <span>总 ROI</span>
                  <el-tooltip :content="metricTips.totalRoi" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
          </div>
        </el-card>

        <!-- Group: 效率 -->
        <el-card class="kpi-card" shadow="never">
          <div class="kpi-group-title">效率</div>
          <div class="kpi-grid">
            <el-statistic :value="currentStats.winRate * 100" :precision="2" suffix="%">
              <template #title>
                <div class="metric-title">
                  <span>胜率 (Win Rate)</span>
                  <el-tooltip :content="metricTips.winRate" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
            <el-statistic :value="currentStats.pnlRatio ?? 0" :precision="2">
              <template #title>
                <div class="metric-title">
                  <span>盈亏比 (P/L Ratio)</span>
                  <el-tooltip :content="metricTips.pnlRatio" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ currentStats?.pnlRatio == null ? '-' : value }}</span>
              </template>
            </el-statistic>
            <el-statistic :value="currentStats.totalR" :precision="2">
              <template #title>
                <div class="metric-title">
                  <span>总 R 值 (Total R)</span>
                  <el-tooltip :content="metricTips.totalR" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
          </div>
        </el-card>

        <!-- Group: 风险 -->
        <el-card class="kpi-card" shadow="never">
          <div class="kpi-group-title">风险</div>
          <div class="kpi-grid">
            <el-statistic :value="currentStats.totalOrders">
              <template #title>
                <div class="metric-title">
                  <span>总订单数</span>
                  <el-tooltip :content="metricTips.totalOrders" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
            <el-statistic :value="currentStats.totalMargin" :precision="2" prefix="$">
              <template #title>
                <div class="metric-title">
                  <span>总保证金</span>
                  <el-tooltip :content="metricTips.totalMargin" placement="top">
                    <span class="metric-tip">?</span>
                  </el-tooltip>
                </div>
              </template>
              <template #value="{ value }">
                <span class="metric-value">{{ value }}</span>
              </template>
            </el-statistic>
          </div>
        </el-card>

        <!-- Charts -->
        <div id="main-chart" class="chart-container"></div>
      </div>

      <el-empty v-if="!loading && !currentStats" description="暂无交易统计数据" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, computed, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
import request from '../utils/request';

const props = defineProps<{
  days: number;
  routeId?: number;
  backtestRunId?: number;
}>();

const loading = ref(false);
const rawStats = ref<any[]>([]); // Data from API
let chartInstance: echarts.ECharts | null = null;

const metricTips = {
  winRate: '胜率 = 盈利单数 / (盈利单数 + 亏损单数)。盈亏为 0 的订单不计入胜率。',
  pnlRatio: '盈亏比 = 平均盈利金额 / 平均亏损金额。若当前没有亏损单，则显示为 - 。',
  totalPnL: '总盈亏 = 统计周期内所有已平仓订单 realized PnL 的累计值（已扣除平仓侧成交手续费，即净盈亏）。',
  totalFees: '总手续费 = 统计周期内所有已平仓订单计入的手续费累计（当前为平仓侧成交手续费，USDT 计价）。',
  totalR: '总 R 值 = 所有订单 R 值之和。单笔 R = (出场价与入场价的有效价差) / (入场价与初始止损价的风险距离)。',
  totalRoi: '总 ROI = 总盈亏(净) / 总保证金 × 100%。总保证金按每笔订单的名义价值 / 杠杆估算后累加。',
  totalOrders: '总订单数 = 统计周期内已平仓且已记录 realized PnL 的订单数量。',
  totalMargin: '总保证金 = 各订单 (入场价 × 数量 × 合约乘数) / 杠杆 的累计值（估算口径，乘数优先取平仓时落库值）。',
};

// Watch props for changes
watch(() => [props.days, props.routeId, props.backtestRunId], () => {
    fetchStats();
});

const currentStats = computed(() => {
    if (rawStats.value.length === 0) return null;

    const agg = {
        totalOrders: 0,
        wins: 0,
        losses: 0,
        neutral: 0,
        sumWinPnL: 0,
        sumLossPnL: 0,
        totalPnL: 0,
        totalFees: 0,
        totalR: 0,
        totalMargin: 0,
        history: {} as Record<string, any>
    };

    rawStats.value.forEach(s => {
        agg.totalOrders += s.totalOrders;
        agg.wins += s.wins || 0;
        agg.losses += s.losses || 0;
        agg.neutral += s.neutral || 0;
        agg.sumWinPnL += s.sumWinPnL || 0;
        agg.sumLossPnL += s.sumLossPnL || 0;
        agg.totalPnL += s.totalPnL;
        agg.totalFees += s.totalFees || 0;
        agg.totalR += s.totalR;
        agg.totalMargin += s.totalMargin || 0;

        Object.keys(s.history).forEach(date => {
            if (!agg.history[date]) {
                agg.history[date] = { pnl: 0, r: 0, roi: 0, margin: 0, count: 0 };
            }
            agg.history[date].pnl += s.history[date].pnl;
            agg.history[date].r += s.history[date].r;
            agg.history[date].margin += s.history[date].margin || 0;
            agg.history[date].count += s.history[date].count;
        });
    });

    Object.keys(agg.history).forEach(date => {
        const bucket = agg.history[date];
        bucket.roi = bucket.margin > 0 ? (bucket.pnl / bucket.margin) * 100 : 0;
    });

    const decisiveTrades = agg.wins + agg.losses;
    const winRate = decisiveTrades > 0 ? agg.wins / decisiveTrades : 0;
    const avgWin = agg.wins > 0 ? agg.sumWinPnL / agg.wins : 0;
    const avgLoss = agg.losses > 0 ? agg.sumLossPnL / agg.losses : 0;
    const pnlRatio = avgLoss > 0 ? avgWin / avgLoss : (agg.wins > 0 ? null : 0);
    const totalRoi = agg.totalMargin > 0 ? (agg.totalPnL / agg.totalMargin) * 100 : 0;

    return {
        ...agg,
        winRate,
        pnlRatio,
        totalRoi
    };
});

const fetchStats = async () => {
  loading.value = true;
  try {
    const res = await request.get('/stats/trading', {
      params: {
          days: props.days,
          routeId: props.routeId,
          backtestRunId: props.backtestRunId
      }
    });
    rawStats.value = res.data;
    
    // Render charts after DOM update
    nextTick(() => {
      renderChart();
    });
  } catch (err) {
    console.error('Failed to fetch stats', err);
  } finally {
    loading.value = false;
  }
};

const buildDateRange = (days: number) => {
  const end = new Date();
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    result.push(d.toISOString().split('T')[0] ?? '');
  }
  return result;
};

/** 回测模式：x 轴直接取实际历史日期键（closedAt 为 K 线触发时间，可能为任意历史区间） */
const buildHistoryDateRange = (history: Record<string, any>) => {
  const keys = Object.keys(history).sort();
  if (keys.length === 0) return buildDateRange(props.days);
  // 起止之间逐日补齐，保证无成交的日期显示为 0
  const start = new Date(keys[0]!);
  const end = new Date(keys[keys.length - 1]!);
  const result: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    result.push(d.toISOString().split('T')[0] ?? '');
  }
  return result;
};

const renderChart = () => {
  if (chartInstance) {
      chartInstance.dispose();
      chartInstance = null;
  }
  
  if (!currentStats.value) return;

  const container = document.getElementById('main-chart');
  if (!container) return;

  chartInstance = echarts.init(container);
  
  const sourceStats = currentStats.value;
  const history = sourceStats.history || {};
  const dates = props.backtestRunId ? buildHistoryDateRange(history) : buildDateRange(props.days);
  const pnlData = dates.map(d => Number(((history[d]?.pnl ?? 0) as number).toFixed(2)));
  const rData = dates.map(d => Number(((history[d]?.r ?? 0) as number).toFixed(2)));
  const roiData = dates.map(d => Number(((history[d]?.roi ?? 0) as number).toFixed(2)));

  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params: any[]) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const title = params[0]?.axisValueLabel ?? '';
        const lines = params.map(p => {
          const value = typeof p.data === 'number' ? p.data.toFixed(2) : p.data;
          return `${p.marker}${p.seriesName}: ${value}`;
        });
        return [title, ...lines].join('<br/>');
      }
    },
    legend: {
      data: ['当日盈亏 (Daily PnL)', '当日 R 值 (Daily R)', '当日 ROI (%)'],
      selected: {
        '当日盈亏 (Daily PnL)': true,
        '当日 R 值 (Daily R)': false,
        '当日 ROI (%)': false
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: dates
    },
    yAxis: [
      {
        type: 'value',
        name: 'PnL ($)',
        position: 'left',
        axisLabel: { formatter: (value: number) => Number(value).toFixed(2) }
      },
      {
        type: 'value',
        name: 'R / ROI',
        position: 'right',
        axisLabel: { formatter: (value: number) => Number(value).toFixed(2) }
      }
    ],
    series: [
      {
        name: '当日盈亏 (Daily PnL)',
        type: 'bar',
        data: pnlData,
        itemStyle: {
          color: (params: any) => {
            const value = Number(params.value)
            return value < 0 ? '#F56C6C' : '#409EFF'
          }
        }
      },
      {
        name: '当日 R 值 (Daily R)',
        type: 'bar',
        yAxisIndex: 1,
        data: rData,
        itemStyle: { color: '#67C23A' }
      },
      {
        name: '当日 ROI (%)',
        type: 'bar',
        yAxisIndex: 1,
        data: roiData,
        itemStyle: { color: '#E6A23C' }
      }
    ]
  };

  chartInstance.setOption(option);
};

onMounted(() => {
  fetchStats();
});

// Resize handler
window.addEventListener('resize', () => {
  chartInstance && chartInstance.resize();
});
</script>

<style scoped>
.trading-stats {
  padding: 20px;
}
.header {
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.filters {
    display: flex;
    align-items: center;
}
.source-section {
  margin-bottom: 12px;
  border-bottom: 1px solid #eee;
  padding-bottom: 12px;
}
.kpi-card {
  background: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  border-radius: var(--border-radius-base);
  padding: 16px;
  margin-bottom: 16px;
}
.kpi-card :deep(.el-card__body) {
  padding: 0;
}
.kpi-group-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 12px;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.metric-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.4;
}
.chart-container {
  width: 100%;
  height: 400px;
  margin-top: 12px;
}
.text-success {
  color: #67C23A;
}
.text-danger {
  color: #F56C6C;
}
.metric-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.metric-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
  color: #606266;
  background: #f2f3f5;
  border: 1px solid #dcdfe6;
  cursor: help;
  user-select: none;
}
.metric-tip:hover {
  color: #303133;
  border-color: #c0c4cc;
}
</style>
