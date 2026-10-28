import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../../api/client", () => ({
  getOps: vi.fn().mockResolvedValue({ items: [] }),
  postAction: vi.fn(),
  streamChat: vi.fn(),
  getMessages: vi.fn(),
}));

vi.mock("../../actions/handleAction", () => ({
  handleAction: vi.fn(),
}));

import { handleAction } from "../../actions/handleAction";
import BillConfirmCard from "./BillConfirmCard.vue";

const baseProps = {
  op_id: "op-1",
  status: "pending",
  data: {
    type: "expense",
    amount_yuan: 200,
    item: "衣服",
    category: "衣服",
    date: "2026-10-27",
    note: null,
  },
  diff: null,
  quip: null,
  warning: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BillConfirmCard", () => {
  it("pending 态显示金额/事项/类目/日期与确认/取消按钮", () => {
    const w = mount(BillConfirmCard, { props: baseProps });
    const text = w.text();
    expect(text).toContain("200");
    expect(text).toContain("衣服");
    expect(text).toContain("2026-10-27");
    expect(w.find("button.confirm").exists()).toBe(true);
    expect(w.find("button.cancel").exists()).toBe(true);
  });

  it("点确认 → handleAction → 已保存 + quip，按钮消失", async () => {
    vi.mocked(handleAction).mockResolvedValue({
      status: "executed",
      bill: { id: 1 },
      deleted: false,
      quip: "这周第3件衣服👕",
    } as never);

    const w = mount(BillConfirmCard, { props: baseProps });
    await w.find("button.confirm").trigger("click");
    await flushPromises();

    expect(handleAction).toHaveBeenCalledWith("bill_create", { op_id: "op-1" });
    expect(w.text()).toContain("已保存");
    expect(w.text()).toContain("这周第3件衣服👕");
    expect(w.find("button.confirm").exists()).toBe(false);
  });

  it("restores saved state and quip from GET /ops on mount (I6)", async () => {
    const { getOps } = await import("../../api/client");
    vi.mocked(getOps).mockResolvedValue({
      items: [
        {
          op_id: "op-1",
          status: "executed",
          result_json: JSON.stringify({
            data: { bill: { id: 9 } },
            quip: "这周第3件衣服👕",
          }),
        },
      ],
    } as never);

    const w = mount(BillConfirmCard, { props: baseProps });
    await flushPromises();

    expect(w.text()).toContain("已保存");
    expect(w.text()).toContain("这周第3件衣服👕");
    expect(w.find("button.confirm").exists()).toBe(false);

    // 还原 mock，避免泄漏到后续用例
    vi.mocked(getOps).mockResolvedValue({ items: [] });
  });

  it("executed 态只读显示 quip，无按钮", () => {
    const w = mount(BillConfirmCard, {
      props: { ...baseProps, status: "saved", quip: "记好啦" },
    });
    expect(w.text()).toContain("已保存");
    expect(w.text()).toContain("记好啦");
    expect(w.find("button.confirm").exists()).toBe(false);
    expect(w.find("button.cancel").exists()).toBe(false);
  });

  it("expired/cancelled 态只读无按钮", () => {
    for (const status of ["cancelled", "expired"] as const) {
      const w = mount(BillConfirmCard, { props: { ...baseProps, status } });
      expect(w.find("button.confirm").exists()).toBe(false);
      expect(w.text()).not.toContain("确认");
    }
  });

  it("确认失败显示错误信息且可重试", async () => {
    vi.mocked(handleAction)
      .mockRejectedValueOnce(new Error("提议已过期，请重新发起"))
      .mockResolvedValueOnce({ status: "executed", bill: {}, deleted: false, quip: null } as never);

    const w = mount(BillConfirmCard, { props: baseProps });
    await w.find("button.confirm").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("提议已过期");

    await w.find("button.confirm").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("已保存");
  });

  it("确认返回 OP_EXPIRED → 卡片翻转为已过期态，按钮消失且无红字错误", async () => {
    vi.mocked(handleAction).mockRejectedValueOnce(
      Object.assign(new Error("提议已过期，请重新发起"), { code: "OP_EXPIRED" }),
    );

    const w = mount(BillConfirmCard, { props: baseProps });
    await w.find("button.confirm").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("提议已过期");
    expect(w.find("button.confirm").exists()).toBe(false);
    expect(w.find(".error").exists()).toBe(false);
  });
});
