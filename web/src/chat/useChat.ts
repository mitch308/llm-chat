import { computed, ref, type Ref } from "vue";
import { streamChat } from "../api/client";
import { useHistory } from "./useHistory";
import type { ChatMsg } from "./types";

/**
 * 单一消息源：history 的 100 条滑动窗口 + 会话内新增的 live 尾巴。
 * 两者拼接展示，互不覆盖（历史翻页不影响新消息，新消息不重置历史）。
 */
export function useChat(): {
  messages: Ref<ChatMsg[]>;
  streaming: Ref<boolean>;
  send: (text: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  canLoadOlder: Ref<boolean>;
  loadingOlder: Ref<boolean>;
} {
  const history = useHistory();
  const liveTail = ref<ChatMsg[]>([]);
  const streaming = ref(false);

  const messages = computed<ChatMsg[]>(() => [...history.window.value, ...liveTail.value]);

  async function send(text: string): Promise<void> {
    if (streaming.value) throw new Error("助手正在回复，请稍候");
    const trimmed = text.trim();
    if (!trimmed) return;

    liveTail.value.push({ role: "user", text: trimmed, specLines: [] });
    const assistant: ChatMsg = { role: "assistant", text: "", specLines: [] };
    liveTail.value.push(assistant);
    streaming.value = true;

    try {
      await streamChat(trimmed, (e) => {
        if (e.type === "text") {
          assistant.text += e.delta;
        } else if (e.type === "spec") {
          assistant.specLines.push(e.line);
        } else if (e.type === "error") {
          // I4：错误事件写入气泡，绝不静默吞掉
          assistant.text += `${assistant.text ? "\n" : ""}⚠ 回复出错：${e.message}`;
        } else if (e.type === "done") {
          if (e.message) assistant.id = e.message.id;
        }
      });
    } finally {
      streaming.value = false;
    }
  }

  return {
    messages,
    streaming,
    send,
    loadOlder: history.loadOlder,
    canLoadOlder: history.canLoadOlder,
    loadingOlder: history.loading,
  };
}
