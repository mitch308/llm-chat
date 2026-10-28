<script setup lang="ts">
const props = defineProps<{
  label: string;
  value: string;
  format?: "currency" | "number" | "percent" | null;
}>();

const display =
  props.format === "currency" && !props.value.startsWith("¥") ? `¥${props.value}` : props.value;
</script>

<template>
  <div class="metric">
    <div class="label">{{ label }}</div>
    <div class="value">{{ display }}</div>
  </div>
</template>

<style scoped>
.metric {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 10px 16px;
  background: #fff;
  min-width: 120px;
}
.label {
  font-size: 12px;
  color: #6b7280;
}
.value {
  font-size: 22px;
  font-weight: 600;
  margin-top: 2px;
}
</style>
