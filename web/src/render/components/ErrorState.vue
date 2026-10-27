<script setup lang="ts">
defineProps<{ message: string; retryable?: boolean | null }>();
const emit = defineEmits<{ (e: "retry"): void }>();
</script>

<template>
  <div class="error-state">
    <span>⚠ {{ message }}</span>
    <button v-if="retryable" @click="emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.error-state {
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
}
button {
  border: none;
  background: #dc2626;
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
}
</style>
