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
  it("propose flow: 服务端直出确认卡片，模型不花卡片轮（1 次 LLM 调用）", async () => {
    let llmRounds = 0;
    const llm = lazyLLM((n) => {
      llmRounds = n + 1;
      if (n === 0) {
        return [
          { type: "text", delta: "好的，帮你记一笔，请确认：" },
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
      return undefined; // 第 2 轮被请求即抛错：卡片之后不允许再有模型轮
    });

    const events = await collect(llm);

    // 序列：text → tool → 服务端 spec×2 → done
    expect(events[0]).toEqual({ type: "text", delta: "好的，帮你记一笔，请确认：" });
    expect(events[1]).toEqual({ type: "tool", name: "propose_op" });
    const specs = events.filter((e) => e.type === "spec") as { type: "spec"; line: string }[];
    expect(specs).toHaveLength(2);
    expect(JSON.parse(specs[0].line)).toEqual({ op: "add", path: "/root", value: "confirm-card" });
    const element = JSON.parse(specs[1].line) as {
      path: string;
      value: { type: string; props: Record<string, unknown> };
    };
    expect(element.path).toBe("/elements/confirm-card");
    expect(element.value.type).toBe("BillConfirmCard");
    expect(element.value.props).toMatchObject({
      kind: "bill_create",
      status: "pending",
      data: { type: "expense", amount_yuan: 200, item: "衣服", category: "衣服", date: "2026-10-27", note: null },
      diff: null,
      quip: null,
      warning: null,
    });
    expect(events[events.length - 1].type).toBe("done");
    expect(llmRounds).toBe(1);

    // 提议落库且 op_id 出现在 spec 里
    const op = pendingOp();
    expect(op).toBeDefined();
    expect(JSON.parse(op!.payload_json)).toMatchObject({ amount_yuan: 200, item: "衣服" });
    expect(specs[1].line).toContain(op!.op_id);

    // assistant 消息：文本 + spec_json 各就各位
    const svc = createMessagesService(db);
    const assistant = svc.listMessages({ limit: 5 }).find((m) => m.role === "assistant")!;
    expect(assistant.spec_json).toBeTruthy();
    expect(JSON.parse(assistant.spec_json!) as string[]).toHaveLength(2);
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

  it("propose_op 重复调用（同 kind+payload）复用既有 pending op_id，服务端直出卡片", async () => {
    const payload = { type: "expense", amount_yuan: 500, item: "停车费", category: "停车", date: "2026-10-27" };
    const seed = createOpsService(db).proposeOp("bill_create", payload);
    let llmRounds = 0;
    const llm = lazyLLM((n) => {
      llmRounds = n + 1;
      if (n === 0) {
        // 模拟模型不稳定：对已存在的提议再次 propose 相同内容
        return [{ type: "tool_calls", calls: [{ id: "call_1", name: "propose_op", arguments: JSON.stringify({ kind: "bill_create", payload }) }] }];
      }
      return undefined;
    });

    const events = await collect(llm);

    // 关键：仍然只有一条提议（重复调用不新建）
    const rows = db.prepare("SELECT status FROM op_proposals").all() as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    const specs = events.filter((e) => e.type === "spec") as { type: "spec"; line: string }[];
    expect(JSON.stringify(specs)).toContain(seed.op_id);
    expect(llmRounds).toBe(1);
  });

  it("近似重复的跨轮叙述在落库时折叠成一份（回归：回复啰嗦；走 execute_op 失败路径）", async () => {
    const llm = lazyLLM((n) => {
      if (n === 0) {
        return [
          { type: "text", delta: "稍等，我确认一下这笔账" },
          { type: "tool_calls", calls: [{ id: "c1", name: "execute_op", arguments: JSON.stringify({ op_id: "wrong" }) }] },
        ];
      }
      if (n === 1) {
        // 模型不稳定：换个说法复读同一句
        return [{ type: "text", delta: "稍等，我确认一下这笔账的保存状态" }];
      }
      return [];
    });

    const events = await collect(llm);
    expect(events.some((e) => e.type === "done")).toBe(true);

    const svc = createMessagesService(db);
    const assistant = svc.listMessages({ limit: 5 }).find((m) => m.role === "assistant")!;
    // 两段近似重复的叙述折叠成一份：关键短语只出现一次
    expect(assistant.content_text.match(/我确认一下/g) ?? []).toHaveLength(1);
    // 失败路径不直出卡片
    expect(events.some((e) => e.type === "spec")).toBe(false);
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

  it("execute_op 成功 → 服务端直出 saved 卡片，模型不花额外轮（1 次 LLM 调用）", async () => {
    const seed = createOpsService(db).proposeOp("bill_create", {
      amount_yuan: 400,
      item: "停车费",
      category: "停车",
      date: "2026-10-27",
    });
    // 只计 agent 回合：quip 后台生成走 tools:[] 的独立调用，不算回合
    let agentRounds = 0;
    const llm: LLMClient = {
      async *stream(input) {
        if (input.tools.length === 0) return; // 后台 quip：空流即可
        agentRounds += 1;
        if (agentRounds > 1) throw new Error(`unexpected agent round ${agentRounds}`);
        yield {
          type: "tool_calls",
          calls: [{ id: "c1", name: "execute_op", arguments: JSON.stringify({ op_id: seed.op_id }) }],
        };
      },
    };

    const events = await collect(llm);

    expect(agentRounds).toBe(1);
    const specs = events.filter((e) => e.type === "spec") as { type: "spec"; line: string }[];
    expect(specs).toHaveLength(2);
    const element = JSON.parse(specs[1].line) as {
      value: { type: string; props: Record<string, unknown> };
    };
    expect(element.value.type).toBe("BillConfirmCard");
    expect(element.value.props).toMatchObject({
      op_id: seed.op_id,
      kind: "bill_create",
      status: "saved",
      data: { type: "expense", amount_yuan: 400, item: "停车费", category: "停车", date: "2026-10-27", note: null },
      quip: null, // quip 后台生成，卡片自轮询补齐
    });
  });

  it("execute_op 失败（提议不存在）→ 不直出卡片，模型解释轮保留", async () => {
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
        : [{ type: "text", delta: "这笔提议找不到了，请重新记一笔" }],
    );

    const events = await collect(llm);
    expect(events.some((e) => e.type === "spec")).toBe(false);
    expect(events[events.length - 1].type).toBe("done");
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
