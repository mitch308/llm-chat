import { describe, expect, it } from "vitest";
import { parseSseChunk } from "./sse";

describe("parseSseChunk", () => {
  it("buffers a frame split across chunks and emits one event", () => {
    const first = parseSseChunk(`data: {"type":"tex`);
    expect(first.events).toEqual([]);
    // 调用方携带 rest 拼接下一 chunk
    const second = parseSseChunk(first.rest + `t","delta":" hi"}\n\n`);
    expect(second.events).toEqual([{ type: "text", delta: " hi" }]);
    expect(second.rest).toBe("");
  });

  it("parses multiple complete frames arriving in one chunk", () => {
    const chunk =
      `data: {"type":"text","delta":"记"}\n\n` +
      `data: {"type":"spec","line":"{\\"op\\":\\"add\\"}"}\n\n` +
      `data: {"type":"done","message":{"id":9}}\n\n`;
    const { events, rest } = parseSseChunk(chunk);
    expect(events).toEqual([
      { type: "text", delta: "记" },
      { type: "spec", line: '{"op":"add"}' },
      { type: "done", message: { id: 9 } },
    ]);
    expect(rest).toBe("");
  });

  it("keeps a trailing partial frame in rest for the next chunk", () => {
    const { events, rest } = parseSseChunk(
      `data: {"type":"text","delta":"a"}\n\ndata: {"type":"text","del`,
    );
    expect(events).toEqual([{ type: "text", delta: "a" }]);
    expect(rest).toBe(`data: {"type":"text","del`);
  });
});
