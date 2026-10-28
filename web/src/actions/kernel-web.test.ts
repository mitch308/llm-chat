import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { handleAction } from "@llm-chat/features/web";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("handleAction", () => {
  it("POSTs the action and returns parsed data", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "executed", bill: { id: 1 }, quip: "好" }), {
        status: 200,
      }),
    );

    const result = await handleAction("bill_create", { op_id: "op-1" });
    expect(result.status).toBe("executed");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("op-1");
  });

  it("409 OP_EXPIRED rejects with the friendly server message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: "OP_EXPIRED", message: "提议已过期，请重新发起" }),
        { status: 409 },
      ),
    );

    await expect(handleAction("bill_create", { op_id: "op-x" })).rejects.toThrow(
      "提议已过期，请重新发起",
    );
  });

  it("network failure rejects with a readable message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(handleAction("bill_create", { op_id: "op-y" })).rejects.toThrow(/连接失败/);
  });
});
