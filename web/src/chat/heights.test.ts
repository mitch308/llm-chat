import { describe, expect, it } from "vitest";
import { estimateItemHeight } from "./heights";
import type { ChatMsg } from "./types";

const msg = (partial: Partial<ChatMsg>): ChatMsg => ({
  role: "user",
  text: "",
  specLines: [],
  ...partial,
});

describe("estimateItemHeight (I7)", () => {
  it("short text message gets a compact base height", () => {
    const h = estimateItemHeight(msg({ text: "记一笔午饭" }));
    expect(h).toBeGreaterThanOrEqual(48);
    expect(h).toBeLessThan(120);
  });

  it("long text grows with wrapped lines", () => {
    const short = estimateItemHeight(msg({ text: "短" }));
    const long = estimateItemHeight(msg({ text: "很长".repeat(200) }));
    expect(long).toBeGreaterThan(short * 3);
  });

  it("spec-bearing messages reserve card/chart space", () => {
    const noSpec = estimateItemHeight(msg({ text: "查到了" }));
    const withSpec = estimateItemHeight(msg({ text: "查到了", specLines: ['{"op":"add"}'] }));
    expect(withSpec - noSpec).toBeGreaterThanOrEqual(200);
  });
});
