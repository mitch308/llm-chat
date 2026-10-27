import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createMessagesService } from "../messages/messages.service";
import type { Delta, LLMClient } from "../chat/llm";
import { runAgent, type AgentEvent } from "./agent";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-agent-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 惰性 fake：每轮调用 getRound(n) 现算脚本（可读取执行中的库状态）。 */
function lazyLLM(getRound: (n: number) => Delta[]): LLMClient {
  let round = 0;
  return {
    async *stream() {
      const deltas = getRound(round);
      if (!deltas) throw new Error(`no round ${round}`);
      round += 1;
      for (const d of deltas) yield d;
    },
  };
}

async function collect(llm: LLMClient): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runAgent({ db, llm, content: "今天买衣服花了200" })) {
    events.push(ev);
  }
  return events;
}

function pendingOp(): { op_id: string; payload_json: string } | undefined {
  return db
    .prepare(`SELECT op_id, payload_json FROM op_proposals WHERE status='pending'`)
    .get() as { op_id: string; payload_json: string } | undefined;
}

describe("runAgent", () => {
  it("propose flow: tool call → card spec with server op_id, persisted", async () => {
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              {
                id: "call_1",
                name: "propose_op",
                arguments: JSON.stringify({
                  kind: "bill_create",
                  payload: {
                    type: "expense",
                    amount_yuan: 200,
                    item: "衣服",
                    category: "衣服",
                    date: "2026-10-27",
                  },
                }),
              },
            ],
          },
        ];
      }
      if (n === 1) {
        const op = pendingOp()!;
        const cardId = "card-1";
        return [
          { type: "text", delta: "帮你记一笔，请确认：\n" },
          { type: "text", delta: "```spec\n" },
          { type: "text", delta: `{"op":"add","path":"/root","value":"${cardId}"}\n` },
          {
            type: "text",
            delta: `{"op":"add","path":"/elements/${cardId}","value":{"type":"BillConfirmCard","props":{"op_id":"${op.op_id}","status":"pending"}},"children":[]}\n`,
          },
          { type: "text", delta: "```\n" },
        ];
      }
      return [];
    });

    const events = await collect(llm);

    // 序列：tool → text → spec×2 → done
    expect(events[0]).toEqual({ type: "tool", name: "propose_op" });
    expect(events[1]).toEqual({ type: "text", delta: "帮你记一笔，请确认：\n" });
    const specs = events.filter((e) => e.type === "spec");
    expect(specs).toHaveLength(2);
    const done = events[events.length - 1];
    expect(done.type).toBe("done");

    // 提议落库且 op_id 出现在 spec 里
    const op = pendingOp();
    expect(op).toBeDefined();
    expect(JSON.parse(op!.payload_json)).toMatchObject({ amount_yuan: 200, item: "衣服" });
    const specLine = JSON.stringify(specs);
    expect(specLine).toContain(op!.op_id);

    // assistant 消息 spec_json 可解析
    const svc = createMessagesService(db);
    const assistant = svc.listMessages({ limit: 5 }).find((m) => m.role === "assistant")!;
    expect(assistant.spec_json).toBeTruthy();
    const parsed = JSON.parse(assistant.spec_json!) as string[];
    expect(parsed).toHaveLength(2);
    expect(assistant.content_text).toContain("帮你记一笔");
  });

  it("spec line split across text deltas within a round stays intact", async () => {
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          { type: "text", delta: "记好了\n" },
          { type: "text", delta: '{"op":"add","path":' },
          { type: "text", delta: '"/root","value":"c1"}\n' },
        ];
      }
      return [];
    });

    const events = await collect(llm);
    const specs = events.filter((e) => e.type === "spec");
    expect(specs).toEqual([
      { type: "spec", line: '{"op":"add","path":"/root","value":"c1"}' },
    ]);
    const texts = events.filter((e) => e.type === "text");
    expect(texts.map((t) => (t as { delta: string }).delta).join("")).toBe("记好了\n");
  });

  it("fallback text-only response streams and persists without spec", async () => {
    const llm = lazyLLM((n) =>
      n === 0
        ? [{ type: "text", delta: "暂不支持该功能，目前支持：📝记账、📰新闻" }]
        : [],
    );

    const events = await collect(llm);
    expect(events.some((e) => e.type === "spec")).toBe(false);
    const done = events[events.length - 1];
    expect(done.type).toBe("done");

    const svc = createMessagesService(db);
    const msgs = svc.listMessages({ limit: 5 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].spec_json).toBeNull();
    expect(msgs[0].content_text).toContain("暂不支持");
  });

  it("invalid tool arguments feed error back to the model then succeed", async () => {
    let sawInvalid = false;
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              { id: "c1", name: "bills_stats", arguments: "{not json" },
            ],
          },
        ];
      }
      if (n === 1) {
        sawInvalid = true;
        return [{ type: "text", delta: "已重新查询\n" }];
      }
      return [];
    });

    const events = await collect(llm);
    expect(events[0]).toEqual({ type: "tool", name: "bills_stats" });
    expect(sawInvalid).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("query_bills tool returns bills to the model", async () => {
    const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO bills (type, amount_cents, item, category_id, date) VALUES ('expense', 3500, '午饭', ?, '2026-10-27')`,
    ).run(catId);

    let round2Seen = false;
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              {
                id: "c1",
                name: "query_bills",
                arguments: JSON.stringify({ from: "2026-10-01", to: "2026-10-31" }),
              },
            ],
          },
        ];
      }
      if (n === 1) {
        round2Seen = true;
        return [{ type: "text", delta: "查到了\n" }];
      }
      return [];
    });

    await collect(llm);
    expect(round2Seen).toBe(true);
  });

  it("news flow: search_news tool → NewsList spec", async () => {
    const searched: unknown[] = [];
    const newsSearch = async (q: unknown) => {
      searched.push(q);
      return {
        items: [
          {
            id: 1,
            source: "hackernews",
            external_id: "hn-1",
            title: "AI release",
            title_zh: "AI 大发布",
            summary_zh: "新模型发布，性能提升。",
            url: "https://hn/1",
            published_at: "2026-10-27T08:00:00Z",
            heat_score: 90,
          },
        ],
        dataTime: "2026-10-27T10:00:00Z",
        skippedSources: ["bbc"],
        failedSources: [],
      };
    };

    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              {
                id: "c1",
                name: "search_news",
                arguments: JSON.stringify({ keywords: ["AI"], mode: "keyword" }),
              },
            ],
          },
        ];
      }
      if (n === 1) {
        return [
          { type: "text", delta: "查到这些新闻：\n" },
          {
            type: "text",
            delta:
              '{"op":"add","path":"/root","value":"n1"}\n{"op":"add","path":"/elements/n1","value":{"type":"NewsList","props":{"items":[{"title_zh":"AI 大发布"}]},"children":[]}}\n',
          },
        ];
      }
      return [];
    });

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({ db, llm, content: "查AI新闻", newsSearch: newsSearch as never })) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "tool", name: "search_news" });
    expect(searched[0]).toMatchObject({ keywords: ["AI"], mode: "keyword" });
    const specs = events.filter((e) => e.type === "spec") as { type: "spec"; line: string }[];
    expect(specs.some((s) => s.line.includes("NewsList"))).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });
});
