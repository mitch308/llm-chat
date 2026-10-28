<script setup lang="ts">
import { computed } from "vue";
import {
  ActionProvider,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/vue";
import { registry } from "../render/registry";
import { linesToSpec } from "../render/specCompile";
import type { ChatMsg } from "./types";

const props = defineProps<{ msg: ChatMsg; typing?: boolean }>();

const spec = computed(() => {
  if (props.msg.specLines.length === 0) return null;
  const compiled = linesToSpec(props.msg.specLines) as {
    root?: string;
    elements?: Record<string, unknown>;
  };
  // 流式中间态防护：root 行先于元素行到达时 elements 缺失，
  // 挂 Renderer 会在 spec.elements[spec.root] 处抛 TypeError（renderer.ts:631）
  const rootElement = compiled.root ? compiled.elements?.[compiled.root] : undefined;
  return rootElement ? (compiled as Record<string, unknown>) : null;
});
const waitingFirstToken = computed(
  () =>
    props.typing === true &&
    props.msg.text.length === 0 &&
    props.msg.specLines.length === 0 &&
    !props.msg.status,
);
</script>

<template>
  <div class="message" :class="msg.role">
    <div class="bubble">
      <div v-if="waitingFirstToken" class="typing" aria-label="正在思考" role="status">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <span v-if="msg.text" class="text">{{ msg.text }}</span>
      <div v-if="msg.status" class="tool-status">{{ msg.status }}</div>
      <div v-if="spec" class="rendered-ui">
        <StateProvider>
          <VisibilityProvider>
            <ActionProvider>
              <Renderer :spec="spec" :registry="registry" />
            </ActionProvider>
          </VisibilityProvider>
        </StateProvider>
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
  max-width: 76%;
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
.rendered-ui {
  margin-top: 6px;
  white-space: normal;
}
.typing {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 0;
}
.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9ca3af;
  animation: typing-bounce 1.2s infinite ease-in-out;
}
.typing .dot:nth-child(2) {
  animation-delay: 0.15s;
}
.typing .dot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes typing-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
.tool-status {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}
</style>
