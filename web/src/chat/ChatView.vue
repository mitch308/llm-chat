<script setup lang="ts">
import { useChat } from "./useChat";
import { provideOpsSync } from "../actions/opsSync";
import MessageList from "./MessageList.vue";
import ChatInput from "./ChatInput.vue";

// 每轮对话结束自增：pending 卡片借此向服务端对账（文字"确认"路径无按钮点击）
const opsSync = provideOpsSync();
const { messages, streaming, send, stop, loadOlder, loadingOlder } = useChat({
  onTurnDone: () => {
    opsSync.value += 1;
  },
});
</script>

<template>
  <div class="chat-view">
    <header class="chat-header">
      <h1>llm-chat</h1>
      <span class="hint">记账 · 新闻 · 富界面对话</span>
    </header>
    <MessageList
      :messages="messages"
      :loading-older="loadingOlder"
      :streaming="streaming"
      @load-older="loadOlder"
    />
    <ChatInput :disabled="streaming" @send="send" @stop="stop" />
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
</style>
