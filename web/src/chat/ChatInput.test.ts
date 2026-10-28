import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ChatInput from "./ChatInput.vue";

describe("ChatInput IME handling (I5)", () => {
  it("does not send while composing (isComposing Enter)", async () => {
    const w = mount(ChatInput, { props: { disabled: false } });
    await w.find("textarea").setValue("nihao");
    await w.find("textarea").trigger("keydown", {
      key: "Enter",
      isComposing: true,
    });
    expect(w.emitted("send")).toBeUndefined();
  });

  it("sends on plain Enter", async () => {
    const w = mount(ChatInput, { props: { disabled: false } });
    await w.find("textarea").setValue("你好");
    await w.find("textarea").trigger("keydown", { key: "Enter", isComposing: false });
    expect(w.emitted("send")).toEqual([["你好"]]);
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it("流式中的停止按钮发出 stop 事件，而非发送", async () => {
    const w = mount(ChatInput, { props: { disabled: true } });
    const stopBtn = w.find("button.stop");
    expect(stopBtn.exists()).toBe(true);
    await stopBtn.trigger("click");
    expect(w.emitted("stop")).toHaveLength(1);
    expect(w.emitted("send")).toBeUndefined();
  });
});
