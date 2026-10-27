<script setup lang="ts">
import type { ChatMsg } from "./types";

defineProps<{ msg: ChatMsg }>();
</script>

<template>
  <div class="message" :class="msg.role">
    <div class="bubble">
      <span class="text">{{ msg.text }}</span>
      <div v-if="msg.specLines.length" class="spec-placeholder">
        [{{ msg.specLines.length }} 行界面数据 — Task 14 渲染]
      </div>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  margin-bottom: 12px;
}
.message.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 72%;
  padding: 8px 12px;
  border-radius: 12px;
  background: #f3f4f6;
  white-space: pre-wrap;
  word-break: break-word;
}
.message.user .bubble {
  background: #3b82f6;
  color: #fff;
}
.spec-placeholder {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
  border-top: 1px dashed #d1d5db;
  padding-top: 6px;
}
.message.user .spec-placeholder {
  display: none;
}
</style>
