import { ref, type Ref } from "vue";
import { getMessages } from "../api/client";
import type { ChatMsg, ServerMessage } from "./types";

const WINDOW_CAP = 100;
const PAGE_SIZE = 20;

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

/** 100 条滑动窗口：初始最新 100；向上翻页 prepend，尾部滑出，窗口恒 ≤100。 */
export function useHistory(): {
  window: Ref<ChatMsg[]>;
  loadOlder: () => Promise<void>;
  canLoadOlder: Ref<boolean>;
  loading: Ref<boolean>;
  /** 供 useChat 合并：直接替换初始窗口（历史加载后又有新消息时）。 */
  replaceWindow: (items: ChatMsg[]) => void;
} {
  const window_ = ref<ChatMsg[]>([]);
  const canLoadOlder = ref(true);
  const loading = ref(false);

  void (async () => {
    try {
      const { items } = await getMessages({ limit: WINDOW_CAP });
      window_.value = items.map(fromServer);
      canLoadOlder.value = items.length === WINDOW_CAP;
    } catch {
      canLoadOlder.value = false;
    }
  })();

  async function loadOlder(): Promise<void> {
    if (loading.value || !canLoadOlder.value) return;
    const oldest = window_.value[0];
    if (!oldest?.id) return;

    loading.value = true;
    try {
      const { items } = await getMessages({ beforeId: oldest.id, limit: PAGE_SIZE });
      if (items.length === 0) {
        canLoadOlder.value = false;
        return;
      }
      const merged = [...items.map(fromServer), ...window_.value];
      window_.value = merged.length > WINDOW_CAP ? merged.slice(0, WINDOW_CAP) : merged;
      canLoadOlder.value = items.length === PAGE_SIZE;
    } catch {
      // 拉取失败：保留窗口，允许再次尝试
    } finally {
      loading.value = false;
    }
  }

  function replaceWindow(items: ChatMsg[]): void {
    window_.value = items;
  }

  return { window: window_, loadOlder, canLoadOlder, loading, replaceWindow };
}
