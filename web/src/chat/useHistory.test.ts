import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  getMessages: vi.fn(),
  streamChat: vi.fn(),
  postAction: vi.fn(),
  getOps: vi.fn(),
}));

import { getMessages } from "../api/client";
import { useHistory } from "./useHistory";

interface Stock {
  id: number;
  role: "user" | "assistant";
  content_text: string;
  spec_json: string | null;
  created_at: string;
}

const stock: Stock[] = Array.from({ length: 150 }, (_, i) => ({
  id: i + 1,
  role: "user" as const,
  content_text: `msg${i + 1}`,
  spec_json: null,
  created_at: "",
}));

function mockApi() {
  vi.mocked(getMessages).mockImplementation(
    async (opts: { beforeId?: number; limit?: number }) => {
      const limit = opts.limit ?? 100;
      const pool = opts.beforeId ? stock.filter((m) => m.id < opts.beforeId!) : stock;
      const page = pool.slice(-limit); // 最新 limit 条（升序）
      return { items: page };
    },
  );
}

beforeEach(mockApi);

describe("useHistory", () => {
  it("initial window is exactly the latest 100 messages", async () => {
    const h = useHistory();
    await vi.waitFor(() => expect(h.window.value).toHaveLength(100));
    expect(h.window.value[0].id).toBe(51);
    expect(h.window.value[99].id).toBe(150);
    expect(h.canLoadOlder.value).toBe(true);
  });

  it("loadOlder prepends 20 older and slides 20 out of the tail (cap 100)", async () => {
    const h = useHistory();
    await vi.waitFor(() => expect(h.window.value).toHaveLength(100));

    await h.loadOlder();
    expect(h.window.value).toHaveLength(100);
    expect(h.window.value[0].id).toBe(31);
    expect(h.window.value[19].id).toBe(50);
    // 尾部滑出 20：最旧可见的是 130 而非 150
    expect(h.window.value[99].id).toBe(130);
  });

  it("reaching the end of history disables canLoadOlder", async () => {
    const h = useHistory();
    await vi.waitFor(() => expect(h.window.value).toHaveLength(100));

    await h.loadOlder(); // 31..50
    await h.loadOlder(); // 11..30
    await h.loadOlder(); // 1..10（不足 20）
    expect(h.window.value[0].id).toBe(1);
    expect(h.canLoadOlder.value).toBe(false);
  });

  it("ignores concurrent loadOlder calls (single fetch)", async () => {
    const h = useHistory();
    await vi.waitFor(() => expect(h.window.value).toHaveLength(100));
    const callsBefore = vi.mocked(getMessages).mock.calls.length;

    await Promise.all([h.loadOlder(), h.loadOlder()]);
    const callsAfter = vi.mocked(getMessages).mock.calls.length;
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
    expect(h.window.value[0].id).toBe(31);
  });
});
