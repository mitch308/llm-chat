import { ref, type Ref } from "vue";
import { getMessages, streamChat } from "../api/client";
import type { ChatMsg, ServerMessage } from "./types";

function fromServer(m: ServerMessage): ChatMsg {
  let specLines: string[] = [];
  if (m.spec_json) {
    try {
      specLines = JSON.parse(m.spec_json) as string[];
    } catch {
      specLines = [];
    }
  }
  return { id: m.id, role: m.role, text: m.content_text, specLines };
}

export function useChat(): {
  messages: Ref<ChatMsg[]>;
  streaming: Ref<boolean>;
  send: (text: string) => Promise<void>;
} {
  const messages = ref<ChatMsg[]>([]);
  const streaming = ref(false);
  let historyLoaded = false;

  void (async () => {
    try {
      const { items } = await getMessages({ limit: 100 });
      // 仅在用户尚未发送消息时回填历史，避免竞态覆盖
      if (!historyLoaded && messages.value.length === 0) {
        messages.value = items.map(fromServer);
      }
    } catch {
      // 历史加载失败：保持空，用户仍可发消息
    }
  })();

  async function send(text: string): Promise<void> {
    if (streaming.value) throw new Error("助手正在回复，请稍候");
    const trimmed = text.trim();
    if (!trimmed) return;
    historyLoaded = true;

    messages.value.push({ role: "user", text: trimmed, specLines: [] });
    const assistant: ChatMsg = { role: "assistant", text: "", specLines: [] };
    messages.value.push(assistant);
    streaming.value = true;

    try {
      await streamChat(trimmed, (e) => {
        if (e.type === "text") {
          assistant.text += e.delta;
        } else if (e.type === "spec") {
          assistant.specLines.push(e.line);
        } else if (e.type === "done") {
          if (e.message) assistant.id = e.message.id;
        }
      });
    } finally {
      streaming.value = false;
    }
  }

  return { messages, streaming, send };
}
