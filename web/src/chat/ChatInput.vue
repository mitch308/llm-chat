<script setup lang="ts">
import { ref } from "vue";

defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ (e: "send", text: string): void }>();
const draft = ref("");

function submit() {
  const text = draft.value.trim();
  if (!text) return;
  emit("send", text);
  draft.value =("");
}
</script>

<template>
  <div class="chat-input">
    <textarea
      v-model="draft"
      :disabled="disabled"
      rows="2"
      placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
      @keydown.enter.exact.prevent="submit"
    />
    <button :disabled="disabled || !draft.trim()" @click="submit">
      {{ disabled ? "回复中…" : "发送" }}
    </button>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
}
textarea {
  flex: 1;
  resize: none;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px;
  font: inherit;
}
button {
  border: none;
  border-radius: 8px;
  background: #3b82f6;
  color: #fff;
  padding: 0 18px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
