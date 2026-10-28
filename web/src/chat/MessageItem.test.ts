import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MessageItem from "./MessageItem.vue";
import type { ChatMsg } from "./types";

const assistant = (over: Partial<ChatMsg> = {}): ChatMsg => ({
  role: "assistant",
  text: "",
  specLines: [],
  ...over,
});

describe("MessageItem 流式交互反馈", () => {
  it("等待首个 token 且无内容时显示三点动画", () => {
    const w = mount(MessageItem, { props: { msg: assistant(), typing: true } });
    expect(w.find(".typing").exists()).toBe(true);
    expect(w.find(".typing").attributes("aria-label")).toBe("正在思考");
  });

  it("文字开始流入后动画消失", () => {
    const w = mount(MessageItem, {
      props: { msg: assistant({ text: "早" }), typing: true },
    });
    expect(w.find(".typing").exists()).toBe(false);
    expect(w.text()).toContain("早");
  });

  it("非流式中的历史消息不显示动画", () => {
    const w = mount(MessageItem, { props: { msg: assistant(), typing: false } });
    expect(w.find(".typing").exists()).toBe(false);
  });

  it("工具执行期间显示状态行", () => {
    const w = mount(MessageItem, {
      props: { msg: assistant({ text: "帮你查一下", status: "正在检索新闻…" }) },
    });
    expect(w.find(".tool-status").text()).toBe("正在检索新闻…");
  });

  it("流式中间态（root 已到、元素未到）不挂 Renderer，避免瞬时崩溃（回归：renderer.ts:631）", () => {
    const partial = assistant({
      specLines: ['{"op":"add","path":"/root","value":"main"}'],
    });
    const w = mount(MessageItem, { props: { msg: partial } });
    expect(() => w.find(".rendered-ui")).not.toThrow();
    // 只有 root 行时 spec 不完整，不应挂载渲染器
    expect(w.find(".rendered-ui").exists()).toBe(false);
  });

  it("root 元素到达后正常挂载渲染器", () => {
    const complete = assistant({
      specLines: [
        '{"op":"add","path":"/root","value":"main"}',
        '{"op":"add","path":"/elements/main","value":{"type":"EmptyState","props":{"message":"空"},"children":[]}}',
      ],
    });
    const w = mount(MessageItem, { props: { msg: complete } });
    expect(w.find(".rendered-ui").exists()).toBe(true);
  });
});
