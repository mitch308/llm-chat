<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useChat } from "./useChat";
import MessageItem from "./MessageItem.vue";
import ChatInput from "./ChatInput.vue";

const { messages, streaming, send } = useChat();
const scroller = ref<HTMLElement | null>(null);

watch(
  () => messages.value.map((m) => m.text.length + m.specLines.length).join(","),
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);
</script>

<template>
  <div class="chat-view">
    <header class="chat-header">
      <h1>llm-chat</h1>
      <span class="hint">记账 · 新闻 · 富界面对话</span>
    </header>
    <div ref="scroller" class="chat-scroll">
      <MessageItem
        v-for="(m, i) in messages"
        :key="m.id ?? `local-${i}`"
        :msg="m"
      />
    </div>
    <ChatInput :disabled="streaming" @send="send" />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.chat-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.chat-header h1 {
  font-size: 16px;
  margin: 0;
}
.hint {
  font-size: 12px;
  color: #9ca3af;
}
.chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
</style>
