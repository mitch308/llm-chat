import { describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { Component } from "vue";
import { BILL_COMPONENTS } from "../../../features/bills/shared";
import { NEWS_COMPONENTS } from "../../../features/news/shared";
import { SHARED_COMPONENTS } from "../../../features/shared/shared";
import { assembleWebRegistry } from "@llm-chat/features/web";
import { registry } from "./registry";

describe("registry", () => {
  it("组件键集合 == BILL ∪ NEWS ∪ SHARED 三份清单的并集（glob 组装）", () => {
    expect(Object.keys(registry).sort()).toEqual(
      [...BILL_COMPONENTS, ...NEWS_COMPONENTS, ...SHARED_COMPONENTS].sort(),
    );
  });

  it("注册项可实际渲染（defineRegistry 契约：componentFn({props}) → VNode，懒加载）", async () => {
    const w = mount(registry.EmptyState as Component, {
      props: {
        element: { props: { message: "空空如也" } },
        emit: vi.fn(),
        on: vi.fn(),
      },
    });
    await vi.dynamicImportSettled(); // 等 vite-node 完成冷启动懒加载 transform
    await flushPromises();
    expect(w.text()).toContain("空空如也");
  });
});

describe("assembleWebRegistry", () => {
  it("缺 default 导出的模块直接抛错", async () => {
    await expect(
      assembleWebRegistry({ "../features/x/web/index.ts": async () => ({}) }),
    ).rejects.toThrow(/default 导出/);
  });
});
