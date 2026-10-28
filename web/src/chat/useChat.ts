import { computed, reactive, ref, type Ref } from "vue";
import { streamChat } from "../api/client";
import { useHistory } from "./useHistory";
import type { ChatMsg } from "./types";

/** 工具事件的过渡文案：让工具执行期的等待可见。 */
const TOOL_STATUS: Record<string, string> = {
  query_bills: "正在查询账单…",
  bills_stats: "正在统计账单…",
  propose_op: "正在准备确认卡片…",
  execute_op: "正在执行操作…",
  search_news: "正在检索新闻…",
};

/**
 * 单一消息源：history 的 100 条滑动窗口 + 会话内新增的 live 尾巴。
 * 两者拼接展示，互不覆盖（历史翻页不影响新消息，新消息不重置历史）。
 */
export function useChat(opts?: {
  /** 服务端 done（本轮落库完成）时回调：供 pending 卡片触发对账翻转 */
  onTurnDone?: () => void;
}): {
  messages: Ref<ChatMsg[]>;
  streaming: Ref<boolean>;
  send: (text: string) => Promise<void>;
  /** 用户主动中断当前流式回复 */
  stop: () => void;
  loadOlder: () => Promise<void>;
  canLoadOlder: Ref<boolean>;
  loadingOlder: Ref<boolean>;
} {
  const history = useHistory();
  const liveTail = ref<ChatMsg[]>([]);
  const streaming = ref(false);
  let controller: AbortController | null = null;

  const messages = computed<ChatMsg[]>(() => [...history.window.value, ...liveTail.value]);

  function stop(): void {
    controller?.abort();
  }

  async function send(text: string): Promise<void> {
    if (streaming.value) throw new Error("助手正在回复，请稍候");
    const trimmed = text.trim();
    if (!trimmed) return;

    liveTail.value.push({ role: "user", text: trimmed, specLines: [] });
    // 关键：reactive 包装——SSE 回调闭包里追加 delta 必须经由代理，
    // 直接改 raw 对象不会触发任何渲染（流式期间界面冻结的根因）
    const assistant = reactive<ChatMsg>({ role: "assistant", text: "", specLines: [] });
    liveTail.value.push(assistant);
    streaming.value = true;
    controller = new AbortController();

    try {
      await streamChat(
        trimmed,
        (e) => {
          if (e.type === "text") {
            assistant.status = undefined;
            assistant.text += e.delta;
          } else if (e.type === "spec") {
            assistant.status = undefined;
            assistant.specLines.push(e.line);
          } else if (e.type === "tool") {
            assistant.status = TOOL_STATUS[e.name] ?? `正在执行 ${e.name}…`;
          } else if (e.type === "error") {
            // I4：错误事件写入气泡，绝不静默吞掉
            assistant.text += `${assistant.text ? "\n" : ""}⚠ 回复出错：${e.message}`;
          } else if (e.type === "done") {
            assistant.status = undefined;
            if (e.message) assistant.id = e.message.id;
            opts?.onTurnDone?.();
          }
        },
        { signal: controller.signal },
      );
    } catch (err) {
      assistant.status = undefined;
      if ((err as { name?: string })?.name === "AbortError") {
        assistant.text += `${assistant.text ? "\n" : ""}⏹ 已停止生成`;
      } else {
        // HTTP 层失败（未配置 key、网络断开等）同样要显示在气泡里，不能静默
        assistant.text += `${assistant.text ? "\n" : ""}⚠ 回复出错：${
          err instanceof Error ? err.message : "未知错误"
        }`;
      }
    } finally {
      assistant.status = undefined;
      streaming.value = false;
      controller = null;
    }
  }

  return {
    messages,
    streaming,
    send,
    stop,
    loadOlder: history.loadOlder,
    canLoadOlder: history.canLoadOlder,
    loadingOlder: history.loading,
  };
}
