import { describe, expect, it, vi, beforeEach } from "vitest";
import { watchEffect } from "vue";
import type { AgentEvent } from "./types";

vi.mock("../api/client", () => ({
  streamChat: vi.fn(),
  getMessages: vi.fn().mockResolvedValue({ items: [] }),
  postAction: vi.fn(),
  getOps: vi.fn(),
}));

import { streamChat, getMessages } from "../api/client";
import { useChat } from "./useChat";

const events: AgentEvent[] = [
  { type: "text", delta: "帮" },
  { type: "text", delta: "你记好了" },
  { type: "spec", line: '{"op":"add","path":"/root","value":"c1"}' },
  { type: "spec", line: '{"op":"add","path":"/elements/c1","value":{}}' },
  { type: "spec", line: '{"op":"add","path":"/state/x","value":1}' },
  { type: "done", message: { id: 9 } },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMessages).mockResolvedValue({ items: [] });
});

describe("useChat", () => {
  it("optimistically appends user message and accumulates assistant from events", async () => {
    vi.mocked(streamChat).mockImplementation(
      async (_content: string, onEvent: (e: AgentEvent) => void) => {
        for (const e of events) onEvent(e);
      },
    );

    const { messages, send, streaming } = useChat();
    expect(streaming.value).toBe(false);

    await send("今天买衣服花了200");

    expect(messages.value).toHaveLength(2);
    const [user, assistant] = messages.value;
    expect(user.role).toBe("user");
    expect(user.text).toBe("今天买衣服花了200");
    expect(assistant.role).toBe("assistant");
    expect(assistant.text).toBe("帮你记好了");
    expect(assistant.specLines).toHaveLength(3);
    expect(assistant.id).toBe(9);
    expect(streaming.value).toBe(false);
    expect(streamChat).toHaveBeenCalledWith(
      "今天买衣服花了200",
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("preloads history from getMessages on init", async () => {
    vi.mocked(getMessages).mockResolvedValue({
      items: [
        { id: 1, role: "user", content_text: "在吗", spec_json: null, created_at: "" },
        {
          id: 2,
          role: "assistant",
          content_text: "在的",
          spec_json: JSON.stringify(['{"op":"add","path":"/root","value":"c"}']),
          created_at: "",
        },
      ],
    });

    const { messages } = useChat();
    await vi.waitFor(() => expect(messages.value).toHaveLength(2));
    expect(messages.value[1].specLines).toHaveLength(1);
    expect(messages.value[1].text).toBe("在的");
  });

  it("surface SSE error events into the assistant message (I4)", async () => {
    vi.mocked(streamChat).mockImplementation(
      async (_c: string, onEvent: (e: AgentEvent) => void) => {
        onEvent({ type: "text", delta: "正在查" });
        onEvent({ type: "error", message: "模型超时" });
      },
    );

    const { messages, send } = useChat();
    await send("查个东西");

    const assistant = messages.value[1];
    expect(assistant.text).toContain("正在查");
    expect(assistant.text).toContain("模型超时");
  });

  it("disables sending while streaming", async () => {    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(streamChat).mockImplementation(
      async (_c: string, onEvent: (e: AgentEvent) => void) => {
        onEvent({ type: "text", delta: "..." });
        await gate;
        onEvent({ type: "done", message: { id: 1 } });
      },
    );

    const chat = useChat();
    const sending = chat.send("第一条");
    await vi.waitFor(() => expect(chat.streaming.value).toBe(true));
    await expect(chat.send("第二条")).rejects.toThrow(/正在回复/);
    release();
    await sending;
    expect(chat.streaming.value).toBe(false);
  });

  it("每个流式 delta 都触发响应式更新（回归：闭包改 raw 对象不触发渲染）", async () => {
    vi.mocked(streamChat).mockImplementation(
      async (_content: string, onEvent: (e: AgentEvent) => void) => {
        onEvent({ type: "text", delta: "早" });
        onEvent({ type: "text", delta: "上好" });
      },
    );

    const { messages, send } = useChat();
    const seen: string[] = [];
    const stopWatch = watchEffect(
      () => {
        const last = messages.value[messages.value.length - 1];
        if (last?.role === "assistant") seen.push(last.text);
      },
      { flush: "sync" },
    );

    await send("打招呼");
    stopWatch();

    // 空气泡、每个中间态、最终态都必须被响应式系统观察到；
    // （结尾可能叠加历史加载完成的额外触发，不作为断言目标）
    expect(seen[0]).toBe("");
    expect(seen).toContain("早");
    expect(seen[seen.length - 1]).toBe("早上好");
  });

  it("stop() 中断流式：保留已到内容并标注已停止，不报错", async () => {
    const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.mocked(streamChat).mockImplementation(
      async (
        _content: string,
        onEvent: (e: AgentEvent) => void,
        opts?: { signal?: AbortSignal },
      ) => {
        onEvent({ type: "text", delta: "部分回答" });
        await new Promise<void>((_resolve, reject) => {
          if (opts?.signal?.aborted) reject(abortError());
          else opts?.signal?.addEventListener("abort", () => reject(abortError()));
        });
      },
    );

    const chat = useChat();
    const sending = chat.send("长问题");
    await vi.waitFor(() => expect(chat.streaming.value).toBe(true));

    chat.stop();
    await sending;

    const assistant = chat.messages.value[1];
    expect(assistant.text).toContain("部分回答");
    expect(assistant.text).toContain("已停止生成");
    expect(assistant.text).not.toContain("⚠");
    expect(chat.streaming.value).toBe(false);
  });

  it("HTTP 层失败（如未配置 key）也要显示在气泡里，不静默吞掉", async () => {
    vi.mocked(streamChat).mockRejectedValue(new Error("chat failed: 500 NO_API_KEY"));

    const chat = useChat();
    await chat.send("在吗");

    const assistant = chat.messages.value[1];
    expect(assistant.text).toContain("⚠ 回复出错");
    expect(assistant.text).toContain("NO_API_KEY");
    expect(chat.streaming.value).toBe(false);
  });

  it("工具执行期间显示状态行，新内容到达后清除", async () => {
    vi.mocked(streamChat).mockImplementation(
      async (_content: string, onEvent: (e: AgentEvent) => void) => {
        onEvent({ type: "tool", name: "search_news" });
        onEvent({ type: "text", delta: "查到了" });
        onEvent({ type: "done", message: { id: 5 } });
      },
    );

    const { messages, send } = useChat();
    const seen: (string | undefined)[] = [];
    const stopWatch = watchEffect(
      () => {
        const last = messages.value[messages.value.length - 1];
        if (last?.role === "assistant") seen.push(last.status);
      },
      { flush: "sync" },
    );

    await send("看新闻");
    stopWatch();

    expect(seen).toContain("正在检索新闻…");
    expect(messages.value[1].status).toBeUndefined();
  });

  it("done 事件触发 onTurnDone 回调（供 pending 卡片对账翻转）", async () => {
    vi.mocked(streamChat).mockImplementation(async (_c, onEvent) => {
      onEvent({ type: "text", delta: "已保存" });
      onEvent({ type: "done", message: { id: 7 } });
    });
    const onTurnDone = vi.fn();
    const chat = useChat({ onTurnDone });

    await chat.send("确认");

    expect(onTurnDone).toHaveBeenCalledTimes(1);
  });
});

