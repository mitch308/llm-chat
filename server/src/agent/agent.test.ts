import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createMessagesService } from "../messages/messages.service";
import { createOpsService } from "../ops/ops.service";
import type { Delta, LLMClient } from "../chat/llm";
import { ASM } from "../features";
import type { ToolEntry } from "@llm-chat/features/server";
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

/** 克隆 ASM.tools 并把 search_news 的执行体换成 fake（替代原 newsSearch 注入位）。
 *  入参→查询的映射与回喂 JSON 形状照抄真实执行体，fake 只接管检索本身。 */
function withSearchNews(fake: (q: unknown) => Promise<unknown>): Map<string, ToolEntry> {
  const tools = new Map(ASM.tools);
  const entry = tools.get("search_news");
  if (!entry) throw new Error("ASM.tools 缺少 search_news（feature 装配异常，检查 features/news 注册）");
  tools.set("search_news", {
    ...entry,
    execute: async (args) => {
      const n = args as {
        keywords?: string[];
        mode?: string;
        source?: string;
        from?: string;
        to?: string;
        limit?: number;
      };
      const keywords = n.keywords ?? [];
      const mode = n.mode === "hot" ? "hot" : keywords.length > 0 ? "keyword" : "hot";
      try {
        const result = await fake({ keywords, mode, source: n.source, from: n.from, to: n.to, limit: n.limit });
        return JSON.stringify({ ok: true, ...(result as object) });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : "新闻查询失败",
        });
      }
    },
  });
  return tools;
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

  it("propose_op 未知 kind → ok:false 未知提议类型，且不落提议（Review Focus 3）", async () => {
    let fedToolResult = "";
    const llm: LLMClient = {
      async *stream(input) {
        const toolMsg = input.messages.find((m) => m.role === "tool");
        if (toolMsg) {
          fedToolResult = toolMsg.content;
          yield { type: "text", delta: "抱歉，我不该乱调工具" };
          return;
        }
        yield {
          type: "tool_calls",
          calls: [
            {
              id: "c1",
              name: "propose_op",
              arguments: JSON.stringify({
                kind: "unknown_kind",
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
        };
      },
    };

    await collect(llm);

    expect(JSON.parse(fedToolResult)).toEqual({
      ok: false,
      error: "未知提议类型: unknown_kind",
    });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM op_proposals").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("propose_op payload 持续非法 → 第 3 次回喂 fatal 放弃（重试升级不被信封通过清零）", async () => {
    const fed: string[] = [];
    const badArgs = JSON.stringify({
      kind: "bill_create",
      payload: { item: "衣服", category: "衣服", date: "2026-10-27" }, // 缺 amount_yuan
    });
    const llm: LLMClient = {
      async *stream(input) {
        const toolMsgs = input.messages.filter((m) => m.role === "tool");
        if (toolMsgs.length === 0) {
          yield { type: "tool_calls", calls: [{ id: "c1", name: "propose_op", arguments: badArgs }] };
          return;
        }
        fed.push(...toolMsgs.slice(fed.length).map((m) => m.content));
        if (toolMsgs.length >= 3) {
          yield { type: "text", delta: "放弃" };
          return;
        }
        yield {
          type: "tool_calls",
          calls: [{ id: `c${toolMsgs.length + 1}`, name: "propose_op", arguments: badArgs }],
        };
      },
    };

    await collect(llm);

    // 前 2 次（≤ MAX_TOOL_RETRIES）回喂具体错误，第 3 次升级 fatal
    expect(fed).toHaveLength(3);
    for (const r of [fed[0], fed[1]]) {
      expect(JSON.parse(r).ok).toBe(false);
      expect(JSON.parse(r).error).toContain("入参不合法");
      expect(JSON.parse(r).fatal).toBeUndefined();
    }
    expect(JSON.parse(fed[2])).toEqual({
      ok: false,
      error: "入参多次不合法，放弃该工具",
      fatal: true,
    });
    // 全程不落提议
    const n = (db.prepare("SELECT COUNT(*) AS n FROM op_proposals").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("propose_op 未知 kind 持续出现 → 第 3 次同样 fatal 放弃（与旧版 kind enum 失败同语义）", async () => {
    const fed: string[] = [];
    const badArgs = JSON.stringify({ kind: "unknown_kind", payload: { anything: 1 } });
    const llm: LLMClient = {
      async *stream(input) {
        const toolMsgs = input.messages.filter((m) => m.role === "tool");
        if (toolMsgs.length === 0) {
          yield { type: "tool_calls", calls: [{ id: "c1", name: "propose_op", arguments: badArgs }] };
          return;
        }
        fed.push(...toolMsgs.slice(fed.length).map((m) => m.content));
        if (toolMsgs.length >= 3) {
          yield { type: "text", delta: "放弃" };
          return;
        }
        yield {
          type: "tool_calls",
          calls: [{ id: `c${toolMsgs.length + 1}`, name: "propose_op", arguments: badArgs }],
        };
      },
    };

    await collect(llm);

    expect(fed).toHaveLength(3);
    expect(JSON.parse(fed[0])).toEqual({ ok: false, error: "未知提议类型: unknown_kind" });
    expect(JSON.parse(fed[1])).toEqual({ ok: false, error: "未知提议类型: unknown_kind" });
    expect(JSON.parse(fed[2])).toEqual({
      ok: false,
      error: "入参多次不合法，放弃该工具",
      fatal: true,
    });
  });

  it("propose_op 重复调用（同 kind+payload）不新建提议，复用既有 pending op_id（回归：工具循环）", async () => {
    const args = JSON.stringify({
      kind: "bill_create",
      payload: { type: "expense", amount_yuan: 500, item: "停车费", category: "停车", date: "2026-10-27" },
    });
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [{ type: "tool_calls", calls: [{ id: "call_1", name: "propose_op", arguments: args }] }];
      }
      if (n === 1) {
        // 模拟模型不稳定：没出卡片，反而再次 propose 相同内容
        return [{ type: "tool_calls", calls: [{ id: "call_2", name: "propose_op", arguments: args }] }];
      }
      if (n === 2) {
        const op = pendingOp()!;
        return [
          { type: "text", delta: "好的，请确认：\n```spec\n" },
          {
            type: "text",
            delta: `{"op":"add","path":"/root","value":"card-1"}\n{"op":"add","path":"/elements/card-1","value":{"type":"BillConfirmCard","props":{"op_id":"${op.op_id}","status":"pending"}},"children":[]}\n`,
          },
          { type: "text", delta: "```\n" },
        ];
      }
      return [];
    });

    const events = await collect(llm);

    // 关键：只落一条提议（修复前会重复插入并被 supersede 成 expired）
    const rows = db.prepare("SELECT status FROM op_proposals").all() as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    const op = db.prepare("SELECT op_id FROM op_proposals").get() as { op_id: string };
    expect(JSON.stringify(events.filter((e) => e.type === "spec"))).toContain(op.op_id);
  });

  it("近似重复的跨轮叙述在落库时折叠成一份（回归：回复啰嗦）", async () => {
    const args = JSON.stringify({
      kind: "bill_create",
      payload: { type: "expense", amount_yuan: 3, item: "早餐", category: "三餐", date: "2026-10-28" },
    });
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          { type: "text", delta: "好的，帮你记一笔早餐支出，请确认～已创建一笔记账提议：10月28日 早餐 3元（三餐）。请确认是否保存～" },
          { type: "tool_calls", calls: [{ id: "c1", name: "propose_op", arguments: args }] },
        ];
      }
      if (n === 1) {
        // 模型不稳定：没出卡片，叙述后又 propose 了一次（duplicate 防护会拦截）
        return [
          { type: "text", delta: "好的，帮你记一笔：今天（10月28日）早餐 3元（三餐）。请确认～" },
          { type: "tool_calls", calls: [{ id: "c2", name: "propose_op", arguments: args }] },
        ];
      }
      if (n === 2) {
        const op = pendingOp()!;
        return [
          { type: "text", delta: "好的，帮你记一笔早餐支出，请确认～已创建一笔记账提议：10月28日 早餐 3元（三餐）。请确认是否保存～\n```spec\n" },
          {
            type: "text",
            delta: `{"op":"add","path":"/root","value":"card-1"}\n{"op":"add","path":"/elements/card-1","value":{"type":"BillConfirmCard","props":{"op_id":"${op.op_id}","status":"pending"}},"children":[]}\n`,
          },
          { type: "text", delta: "```\n请确认无误后保存～" },
        ];
      }
      return [];
    });

    const events = await collect(llm);
    expect(events.some((e) => e.type === "done")).toBe(true);

    const svc = createMessagesService(db);
    const assistant = svc.listMessages({ limit: 5 }).find((m) => m.role === "assistant")!;
    // 三段近似重复的叙述折叠成一份：关键短语只出现一次，卡片 spec 完整保留
    expect(assistant.content_text.match(/请确认是否保存/g) ?? []).toHaveLength(1);
    expect(assistant.spec_json).toBeTruthy();
  });

  it("转向其他任务时，启动时已 pending 的提议自动取消（回归：卡片滞留 pending）", async () => {
    // 上一轮遗留的 pending 提议
    const seed = createOpsService(db).proposeOp("bill_create", {
      amount_yuan: 400,
      item: "停车费",
      category: "停车",
      date: "2026-10-27",
    });

    // 本轮只查新闻，没确认也没提议 → 用户已"切换任务"
    const llm = lazyLLM((n) =>
      n === 0 ? [{ type: "text", delta: "今天的头条是……" }] : [],
    );
    await collect(llm);

    const status = db
      .prepare("SELECT status FROM op_proposals WHERE op_id = ?")
      .get(seed.op_id) as { status: string };
    expect(status.status).toBe("cancelled");
  });

  it("确认轮（execute_op）不触发自动取消", async () => {
    const seed = createOpsService(db).proposeOp("bill_create", {
      amount_yuan: 400,
      item: "停车费",
      category: "停车",
      date: "2026-10-27",
    });

    const llm = lazyLLM((n) =>
      n === 0
        ? [
            {
              type: "tool_calls",
              calls: [
                { id: "c1", name: "execute_op", arguments: JSON.stringify({ op_id: seed.op_id }) },
              ],
            },
          ]
        : [{ type: "text", delta: "已保存" }],
    );
    await collect(llm);

    const status = db
      .prepare("SELECT status FROM op_proposals WHERE op_id = ?")
      .get(seed.op_id) as { status: string };
    expect(status.status).toBe("executed");
  });

  it("execute_op 失败也不自动取消（保留重试机会）", async () => {
    const seed = createOpsService(db).proposeOp("bill_create", {
      amount_yuan: 400,
      item: "停车费",
      category: "停车",
      date: "2026-10-27",
    });

    // 模型拿错 op_id：执行失败，但本轮已尝试确认 → 不取消
    const llm = lazyLLM((n) =>
      n === 0
        ? [
            {
              type: "tool_calls",
              calls: [
                { id: "c1", name: "execute_op", arguments: JSON.stringify({ op_id: "wrong" }) },
              ],
            },
          ]
        : [{ type: "text", delta: "稍等，我再试一次" }],
    );
    await collect(llm);

    const status = db
      .prepare("SELECT status FROM op_proposals WHERE op_id = ?")
      .get(seed.op_id) as { status: string };
    expect(status.status).toBe("pending");
  });

  it("本轮新建的提议不误伤（旧提议被取消，新提议保持 pending）", async () => {
    const seed = createOpsService(db).proposeOp("bill_create", {
      amount_yuan: 3,
      item: "早饭",
      category: "三餐",
      date: "2026-10-28",
    });

    // 用户没确认早饭，转而记停车费
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              {
                id: "c1",
                name: "propose_op",
                arguments: JSON.stringify({
                  kind: "bill_create",
                  payload: { type: "expense", amount_yuan: 400, item: "停车费", category: "停车", date: "2026-10-27" },
                }),
              },
            ],
          },
        ];
      }
      if (n === 1) {
        const op = pendingOp()!;
        return [
          { type: "text", delta: "好的，请确认：\n```spec\n" },
          {
            type: "text",
            delta: `{"op":"add","path":"/root","value":"card-1"}\n{"op":"add","path":"/elements/card-1","value":{"type":"BillConfirmCard","props":{"op_id":"${op.op_id}","status":"pending"}},"children":[]}\n`,
          },
          { type: "text", delta: "```\n" },
        ];
      }
      return [];
    });
    await collect(llm);

    const old = db.prepare("SELECT status FROM op_proposals WHERE op_id = ?").get(seed.op_id) as { status: string };
    const rows = db.prepare("SELECT status FROM op_proposals").all() as { status: string }[];
    expect(old.status).toBe("cancelled");
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("spec line split across text deltas within a round stays intact", async () => {    const llm = lazyLLM((n) => {
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

  it("tool execution errors are fed back to the model instead of crashing (I1)", async () => {
    let recovered = false;
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          {
            type: "tool_calls",
            calls: [
              {
                id: "c1",
                name: "query_bills",
                arguments: JSON.stringify({ category: "不存在的类目" }),
              },
            ],
          },
        ];
      }
      if (n === 1) {
        recovered = true;
        return [{ type: "text", delta: "换个说法再试\n" }];
      }
      return [];
    });

    const events = await collect(llm);
    expect(events[0]).toEqual({ type: "tool", name: "query_bills" });
    expect(recovered).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
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
    for await (const ev of runAgent({ db, llm, content: "查AI新闻", tools: withSearchNews(newsSearch) })) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "tool", name: "search_news" });
    expect(searched[0]).toMatchObject({ keywords: ["AI"], mode: "keyword" });
    const specs = events.filter((e) => e.type === "spec") as { type: "spec"; line: string }[];
    expect(specs.some((s) => s.line.includes("NewsList"))).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("模型可见工具 def 名集合 = 内核 op 工具 + feature 注册表（恰五件，防漂移）", async () => {
    let seen: string[] = [];
    const llm: LLMClient = {
      async *stream(input) {
        seen = input.tools.map((t) => t.function.name);
        yield { type: "text", delta: "ok" };
      },
    };
    await collect(llm);
    expect(seen.sort()).toEqual([
      "bills_stats",
      "execute_op",
      "propose_op",
      "query_bills",
      "search_news",
    ]);
  });

  it("isCancelled 中断：已产出的部分内容落库，且不再发 done 事件", async () => {
    let stopped = false;
    const llm: LLMClient = {
      async *stream() {
        yield { type: "text", delta: "第一段\n" };
        // 模拟还在持续生成的后续 token
        while (!stopped) await new Promise((r) => setTimeout(r, 2));
        yield { type: "text", delta: "第二段\n" };
      },
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({ db, llm, content: "hi", isCancelled: () => stopped })) {
      events.push(ev);
      stopped = true;
    }

    expect(events).toEqual([{ type: "text", delta: "第一段\n" }]);
    const svc = createMessagesService(db);
    const assistant = svc.listMessages({ limit: 5 }).find((m) => m.role === "assistant");
    expect(assistant?.content_text).toContain("第一段");
    expect(assistant?.content_text).not.toContain("第二段");
  });

  it("isCancelled 且无任何内容时：不落空 assistant 消息", async () => {
    const llm: LLMClient = {
      async *stream() {
        yield { type: "text", delta: "会被丢弃的 token" };
      },
    };

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({ db, llm, content: "hi", isCancelled: () => true })) {
      events.push(ev);
    }

    expect(events).toEqual([]);
    const svc = createMessagesService(db);
    const roles = svc.listMessages({ limit: 5 }).map((m) => m.role);
    expect(roles).toEqual(["user"]);
  });
});
