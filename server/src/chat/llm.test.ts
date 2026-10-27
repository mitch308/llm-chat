import { describe, expect, it } from "vitest";
import {
  createFakeLLM,
  createZhipuClient,
  resolveLLMConfig,
  type Delta,
} from "./llm";

describe("resolveLLMConfig", () => {
  it("reads key/model/baseUrl from env with spec defaults", () => {
    const prev = { ...process.env };
    process.env.ZHIPU_API_KEY = "sk-test";
    process.env.ZHIPU_MODEL = "glm-4.7-flash";
    process.env.ZHIPU_BASE_URL = "https://custom.example/v4";
    try {
      const cfg = resolveLLMConfig();
      expect(cfg).toEqual({
        apiKey: "sk-test",
        model: "glm-4.7-flash",
        baseUrl: "https://custom.example/v4",
      });
    } finally {
      for (const k of ["ZHIPU_API_KEY", "ZHIPU_MODEL", "ZHIPU_BASE_URL"] as const) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    }
  });

  it("falls back to glm-5.3-flash and the zhipu endpoint", () => {
    const prev = { ...process.env };
    delete process.env.ZHIPU_API_KEY;
    delete process.env.ZHIPU_MODEL;
    delete process.env.ZHIPU_BASE_URL;
    try {
      const cfg = resolveLLMConfig();
      expect(cfg.model).toBe("glm-5.3-flash");
      expect(cfg.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
      expect(cfg.apiKey).toBe("");
    } finally {
      for (const k of ["ZHIPU_API_KEY", "ZHIPU_MODEL", "ZHIPU_BASE_URL"] as const) {
        if (prev[k] !== undefined) process.env[k] = prev[k]!;
      }
    }
  });
});

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
