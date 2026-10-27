import { describe, expect, it, vi, beforeEach } from "vitest";
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
    expect(streamChat).toHaveBeenCalledWith("今天买衣服花了200", expect.any(Function));
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
});
