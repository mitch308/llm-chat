<script setup lang="ts">
import { computed } from "vue";
import { Renderer, StateProvider, VisibilityProvider } from "@json-render/vue";
import { registry } from "../render/registry";
import { linesToSpec } from "../render/specCompile";
import type { ChatMsg } from "./types";

const props = defineProps<{ msg: ChatMsg }>();

const spec = computed(() =>
  props.msg.specLines.length > 0 ? linesToSpec(props.msg.specLines) : null,
);
</script>

<template>
  <div class="message" :class="msg.role">
    <div class="bubble">
      <span v-if="msg.text" class="text">{{ msg.text }}</span>
      <div v-if="msg.specLines.length" class="rendered-ui">
        <StateProvider>
          <VisibilityProvider>
            <Renderer v-if="spec" :spec="spec" :registry="registry" />
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
</style>
