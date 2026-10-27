<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div class="empty">{{ message }}</div>
</template>

<style scoped>
.empty {
  border: 1px dashed #d1d5db;
  border-radius: 12px;
  padding: 16px;
  color: #6b7280;
  font-size: 13px;
  text-align: center;
}
</style>
