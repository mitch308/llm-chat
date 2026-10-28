<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import type { ChatMsg } from "./types";
import { estimateItemHeight } from "./heights";
import MessageItem from "./MessageItem.vue";

const props = defineProps<{ messages: ChatMsg[]; loadingOlder: boolean }>();
const emit = defineEmits<{ (e: "load-older"): void }>();

const containerRef = ref<HTMLElement | null>(null);
// 注意：@vueuse/core 15 的 useVirtualList 不对 list 做 toValue，只接受数组或 ref
// （shallowRef(getter) 会把函数本身当 source）——必须传 computed，不能传裸 getter
const messagesRef = computed(() => props.messages);
const { list, containerProps, wrapperProps } = useVirtualList(messagesRef, {
  // I7：按内容估算高度，替代固定 88px（长文/卡片/图表差异巨大）
  itemHeight: (index: number) =>
    estimateItemHeight(
      messagesRef.value[index] ?? { role: "user", text: "", specLines: [] },
    ),
  overscan: 8,
});

const atBottom = ref(true);
const lastFirstKey = ref<string>("");

function onScroll() {
  const el = containerRef.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (el.scrollTop < 120 && props.loadingOlder === false && atOlderTop()) {
    emit("load-older");
  }
}

function atOlderTop(): boolean {
  return containerRef.value ? containerRef.value.scrollTop <= 4 : false;
}

async function goBottom(smooth = true) {
  await nextTick();
  const el = containerRef.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

watch(
  () => props.messages.map((m) => `${m.id ?? "l"}:${m.text.length}:${m.specLines.length}`).join("|"),
  async (_newKeys, _old) => {
    const el = containerRef.value;
    if (!el) return;
    const firstKey = props.messages[0] ? String(props.messages[0].id ?? "l") : "";
    const prepended = firstKey !== lastFirstKey.value && lastFirstKey.value !== "";
    lastFirstKey.value = firstKey;

    if (prepended && el.scrollTop <= 4) {
      // prepend 不跳动：补偿新增内容高度
      const before = el.scrollHeight;
      await nextTick();
      el.scrollTop += el.scrollHeight - before;
    } else if (atBottom.value) {
      await goBottom(false);
    }
  },
);

watch(
  () => props.messages.length,
  () => {
    if (!lastFirstKey.value && props.messages[0]) {
      lastFirstKey.value = String(props.messages[0].id ?? "l");
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="message-list">
    <div v-bind="containerProps" class="scroll-container" @scroll.passive="onScroll">
      <div v-bind="wrapperProps">
        <div v-for="{ data, index } in list" :key="data.id ?? `i-${index}`" class="row">
          <MessageItem :msg="data" />
        </div>
      </div>
    </div>
    <div v-if="loadingOlder" class="older-hint">加载更早消息…</div>
    <button v-if="!atBottom" class="to-bottom" @click="goBottom()">回到底部 ↓</button>
  </div>
</template>

<style scoped>
.message-list {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scroll-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.older-hint {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  color: #6b7280;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  padding: 2px 10px;
}
.to-bottom {
  position: absolute;
  bottom: 12px;
  right: 16px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}
</style>
