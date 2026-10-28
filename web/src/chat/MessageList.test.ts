import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import MessageList from "./MessageList.vue";
import type { ChatMsg } from "./types";

// jsdom 无 ResizeObserver：模拟真实浏览器行为——observe 时异步回调一次容器尺寸
class ResizeObserverStub {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    setTimeout(() => {
      this.cb(
        [
          {
            target,
            contentRect: { width: 400, height: 800 },
            borderBoxSize: [],
            contentBoxSize: [{ inlineSize: 400, blockSize: 800 }],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        target as unknown as ResizeObserver,
      );
    }, 0);
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const msgs: ChatMsg[] = [
  { id: 1, role: "user", text: "记一笔午饭", specLines: [] },
  {
    id: 2,
    role: "assistant",
    text: "查到了",
    specLines: [
      '{"op":"add","path":"/root","value":"c1"}',
      '{"op":"add","path":"/elements/c1","value":{"type":"EmptyState","props":{"message":"空空如也"},"children":[]}}',
    ],
  },
];

describe("MessageList", () => {
  it("mounts with a getter-derived message array and function itemHeight without crashing", async () => {
    const w = mount(MessageList, {
      props: { messages: msgs, loadingOlder: false },
      attachTo: document.body,
    });
    // 等 ResizeObserverStub 异步回调驱动 calculateRange
    await new Promise((r) => setTimeout(r, 5));

    // 两条消息都渲染（含带 spec 的消息），虚拟窗口 wrapper 高度按估算函数求值
    expect(w.findAll(".row")).toHaveLength(2);
    const wrapper = w.find(".scroll-container > div");
    expect(wrapper.exists()).toBe(true);
    const style = wrapper.attributes("style") ?? "";
    expect(style).toMatch(/height:\s*\d+px/);
    w.unmount();
  });

  it("re-renders when the messages prop changes", async () => {
    const w = mount(MessageList, {
      props: { messages: msgs.slice(0, 1), loadingOlder: false },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.findAll(".row")).toHaveLength(1);
    await w.setProps({ messages: msgs });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.findAll(".row")).toHaveLength(2);
    w.unmount();
  });
});
