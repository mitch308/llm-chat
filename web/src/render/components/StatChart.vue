<script setup lang="ts">
const props = defineProps<{
  chart: "bar" | "line";
  title?: string | null;
  series: { name: string; value: number }[];
}>();

const max = Math.max(...props.series.map((s) => s.value), 1);
</script>

<template>
  <div class="stat-chart">
    <div v-if="title" class="chart-title">{{ title }}</div>
    <div class="bars">
      <div v-for="s in series" :key="s.name" class="bar-row">
        <span class="bar-label">{{ s.name }}</span>
        <div class="bar-track">
          <div class="bar" :style="{ width: `${(s.value / max) * 100}%` }" />
        </div>
        <span class="bar-value">{{ s.value }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-chart {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px;
  background: #fff;
  max-width: 420px;
}
.chart-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.bar-row {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  margin-bottom: 6px;
}
.bar-label {
  color: #6b7280;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-track {
  background: #f3f4f6;
  border-radius: 4px;
  height: 12px;
  overflow: hidden;
}
.bar {
  background: #3b82f6;
  height: 100%;
  border-radius: 4px;
}
.bar-value {
  color: #374151;
}
</style>
