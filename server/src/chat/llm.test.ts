import { describe, expect, it } from "vitest";
import { createFakeLLM, createZhipuClient, type Delta } from "./llm";

describe("createFakeLLM", () => {
  it("replays scripted rounds per stream() call", async () => {
    const script: Delta[][] = [
      [
        { type: "text", delta: "帮" },
        { type: "text", delta: "你记" },
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "propose_op", arguments: '{"kind":"bill_create"}' }],
        },
      ],
      [{ type: "text", delta: "记好了" }],
    ];
    const llm = createFakeLLM(script);

    const round1: Delta[] = [];
    for await (const d of llm.stream({
      system: "s",
      messages: [{ role: "user", content: "记账" }],
      tools: [],
    })) {
      round1.push(d);
    }
    expect(round1).toEqual(script[0]);

    const round2: Delta[] = [];
    for await (const d of llm.stream({
      system: "s",
      messages: [{ role: "user", content: "记账" }],
      tools: [],
    })) {
      round2.push(d);
    }
    expect(round2).toEqual(script[1]);
  });

  it("throws when a script round is exhausted", async () => {
    const llm = createFakeLLM([[{ type: "text", delta: "x" }]]);
    const consume = async () => {
      for await (const _ of llm.stream({ system: "", messages: [], tools: [] })) {
        // drain
      }
    };
    await consume();
    await expect(consume()).rejects.toThrow(/script exhausted/i);
  });
});

describe("createZhipuClient", () => {
  it("throws ZHIPU_API_KEY missing without a key (no network)", () => {
    expect(() => createZhipuClient({ apiKey: "" })).toThrow("ZHIPU_API_KEY missing");
  });
});
