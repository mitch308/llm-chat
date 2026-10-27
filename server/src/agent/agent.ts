import type Database from "better-sqlite3";
import { z } from "zod";
import type { LLMClient, ModelMsg, ToolCall } from "../chat/llm";
import { createMessagesService } from "../messages/messages.service";
import { buildContext } from "../chat/context";
import { createSpecSplitter } from "../chat/streamSplitter";
import { createOpsService } from "../ops/ops.service";
import { attachQuip, runBillAction, storeResult, type OpAction } from "../ops/ops.executor";
import { billStats, listBills } from "../bills/bills.service";
import { TOOL_DEFS } from "./tools";
import { createNewsService, type NewsSearchResult, type SearchNewsQuery } from "../news/news.service";
import { buildSourceFetchers } from "../news/fetchers";
import type { SourceId } from "../news/sources";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "spec"; line: string }
  | { type: "tool"; name: string }
  | { type: "done"; message?: { id: number } };

const MAX_ROUNDS = 6;
const MAX_TOOL_RETRIES = 2;

/** 工具入参 schema（zod）：失败回喂错误让模型重试。 */
const argSchemas = {
  query_bills: z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      category: z.string().optional(),
      type: z.enum(["expense", "income"]).optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  bills_stats: z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(["expense", "income"]).optional(),
      group_by: z.enum(["category", "date"]),
      level: z.enum(["parent", "leaf"]).optional(),
    })
    .strict(),
  propose_op: z
    .object({
      kind: z.enum(["bill_create", "bill_update", "bill_delete"]),
      payload: z
        .object({
          type: z.enum(["expense", "income"]).optional(),
          amount_yuan: z.number().positive(),
          item: z.string().min(1),
          category: z.string().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          note: z.string().optional(),
          id: z.number().int().optional(),
        })
        .passthrough(),
    })
    .strict(),
  execute_op: z.object({ op_id: z.string().min(1) }).strict(),
  search_news: z
    .object({
      keywords: z.array(z.string()).optional(),
      mode: z.enum(["keyword", "hot"]).optional(),
      source: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().optional(),
    })
    .strict(),
} as const;

/** AGENT 循环：上下文 → 流式输出 → 工具执行回喂 → 落库。 */
export async function* runAgent(opts: {
  db: Database;
  llm: LLMClient;
  content: string;
  /** 可注入的新闻检索（测试用）；默认按需抓取的真实服务。 */
  newsSearch?: (q: SearchNewsQuery) => Promise<NewsSearchResult>;
}): AsyncIterable<AgentEvent> {
  const { db, llm, content } = opts;
  const messages = createMessagesService(db);
  const ops = createOpsService(db);
  const newsSearch =
    opts.newsSearch ??
    createNewsService({ db, llm, fetchers: buildSourceFetchers() }).searchNews;

  messages.appendMessage({ role: "user", contentText: content });
  const { system, messages: history } = buildContext(db);

  const splitter = createSpecSplitter();
  const textParts: string[] = [];
  const specLines: string[] = [];
  const convo: ModelMsg[] = [...history];
  const retries = new Map<string, number>();

  function* emitSplit(events: Iterable<{ kind: string; delta?: string; line?: string }>) {
    for (const ev of events) {
      if (ev.kind === "text" && ev.delta !== undefined) {
        textParts.push(ev.delta);
        yield { type: "text", delta: ev.delta } as AgentEvent;
      } else if (ev.kind === "spec" && ev.line !== undefined) {
        specLines.push(ev.line);
        yield { type: "spec", line: ev.line } as AgentEvent;
      }
    }
  }

  async function executeTool(call: ToolCall): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return JSON.stringify({ ok: false, error: "入参不是合法 JSON" });
    }
    const schema = argSchemas[call.name as keyof typeof argSchemas];
    if (schema) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const used = (retries.get(call.name) ?? 0) + 1;
        retries.set(call.name, used);
        if (used > MAX_TOOL_RETRIES) {
          return JSON.stringify({ ok: false, error: "入参多次不合法，放弃该工具", fatal: true });
        }
        return JSON.stringify({
          ok: false,
          error: `入参不合法: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        });
      }
      args = parsed.data;
    }
    retries.delete(call.name);

    const a = args as Record<string, string | number | string[] | undefined>;
    switch (call.name) {
      case "query_bills": {
        const items = listBills(db, {
          from: a.from,
          to: a.to,
          category: a.category,
          type: a.type,
          kw: a.q,
          limit: a.limit ?? 20,
        });
        return JSON.stringify({ ok: true, items });
      }
      case "bills_stats": {
        const items = billStats(db, {
          from: a.from,
          to: a.to,
          type: a.type,
          groupBy: a.group_by,
          level: a.level,
        });
        return JSON.stringify({ ok: true, items });
      }
      case "propose_op": {
        const p = a as unknown as { kind: OpAction; payload: Record<string, unknown> };
        const proposal = ops.proposeOp(p.kind, p.payload);
        return JSON.stringify({
          ok: true,
          op_id: proposal.op_id,
          kind: proposal.kind,
          payload: p.payload,
          hint: "用 op_id 生成 BillConfirmCard（status=pending），不要直接写库",
        });
      }
      case "execute_op": {
        const p = a as unknown as { op_id: string };
        const proposal = ops.getOps([p.op_id])[0];
        if (!proposal) return JSON.stringify({ ok: false, error: "提议不存在" });
        try {
          const outcome = await ops.executeOp(p.op_id, async (payload) =>
            runBillAction(db, proposal.kind, payload as Record<string, unknown>),
          );
          if (outcome.status === "invalid") {
            return JSON.stringify({ ok: false, error: outcome.message });
          }
          const data = outcome.data as { bill: import("../bills/bills.service").Bill; deleted?: boolean };
          const quip = await attachQuip(db, llm, data.bill);
          storeResult(db, p.op_id, { bill: data.bill, deleted: data.deleted }, quip);
          return JSON.stringify({ ok: true, status: outcome.status, bill: data.bill, quip });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : "执行失败",
          });
        }
      }
      case "search_news": {
        const keywords = Array.isArray(a.keywords) ? (a.keywords as string[]) : [];
        const mode = a.mode === "hot" ? "hot" : keywords.length > 0 ? "keyword" : "hot";
        try {
          const result = await newsSearch({
            keywords,
            mode,
            source: typeof a.source === "string" ? (a.source as SourceId) : undefined,
            from: typeof a.from === "string" ? a.from : undefined,
            to: typeof a.to === "string" ? a.to : undefined,
            limit: typeof a.limit === "number" ? a.limit : undefined,
          });
          return JSON.stringify({ ok: true, ...result });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : "新闻查询失败",
          });
        }
      }
      default:
        return JSON.stringify({ ok: false, error: `未知工具: ${call.name}` });
    }
  }

  let finalMessage: { id: number } | undefined;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let calls: ToolCall[] = [];
    let roundText = "";

    for await (const delta of llm.stream({ system, messages: convo, tools: TOOL_DEFS })) {
      if (delta.type === "text") {
        roundText += delta.delta;
        yield* emitSplit(splitter.feed(delta.delta));
      } else {
        calls = delta.calls;
      }
    }

    if (calls.length === 0) {
      break;
    }

    // 回喂：assistant(tool_calls) + 每个 tool 的结果
    convo.push({ role: "assistant", content: roundText, tool_calls: calls });
    for (const call of calls) {
      yield { type: "tool", name: call.name };
      const result = await executeTool(call);
      convo.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  yield* emitSplit(splitter.end());

  const saved = messages.appendMessage({
    role: "assistant",
    contentText: textParts.join(""),
    specJson: specLines.length > 0 ? JSON.stringify(specLines) : null,
  });
  finalMessage = { id: saved.id };

  yield { type: "done", message: finalMessage };
}
