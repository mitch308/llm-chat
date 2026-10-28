<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import * as echarts from "echarts";

const props = defineProps<{
  chart: "bar" | "line";
  title?: string | null;
  series: { name: string; value: number }[];
}>();

const container = ref<HTMLElement | null>(null);
let instance: echarts.ECharts | null = null;

function buildOption() {
  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: props.series.map((s) => s.name),
    },
    yAxis: { type: "value" },
    series: [
      {
        type: props.chart,
        data: props.series.map((s) => s.value),
        itemStyle: { color: "#3b82f6" },
      },
    ],
  };
}

onMounted(() => {
  if (!container.value) return;
  try {
    instance = echarts.init(container.value);
    instance.setOption(buildOption());
  } catch {
    // 渲染环境不支持（如测试 jsdom）：保留容器
  }
});

watch(
  () => [props.chart, props.series],
  () => instance?.setOption(buildOption()),
  { deep: true },
);

onUnmounted(() => {
  instance?.dispose();
  instance = null;
});
</script>

<template>
  <div class="stat-chart">
    <div v-if="title" class="chart-title">{{ title }}</div>
    <div ref="container" class="chart-container" />
  </div>
</template>

<style scoped>
.stat-chart {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px;
  background: #fff;
  max-width: 460px;
}
.chart-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.chart-container {
  width: 100%;
  height: 220px;
}
</style>
