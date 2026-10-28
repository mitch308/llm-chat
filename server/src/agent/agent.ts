import type Database from "better-sqlite3";
import { z } from "zod";
import type { LLMClient, ModelMsg, ToolCall } from "../chat/llm";
import { createMessagesService } from "../messages/messages.service";
import { buildContext } from "../chat/context";
import { createSpecSplitter } from "../chat/streamSplitter";
import { createOpsService } from "../ops/ops.service";
import { attachQuipInBackground, runBillAction, storeResult, type OpAction } from "../ops/ops.executor";
import { billStats, listBills } from "../../../features/bills/server/bills.service";
import { TOOL_DEFS } from "./tools";
import { createNewsService, type NewsSearchResult, type SearchNewsQuery } from "../../../features/news/server/news.service";
import { buildSourceFetchers } from "../../../features/news/server/fetchers";
import type { SourceId } from "../../../features/news/server/sources";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "spec"; line: string }
  | { type: "tool"; name: string }
  | { type: "done"; message?: { id: number } };

const MAX_ROUNDS = 6;
const MAX_TOOL_RETRIES = 2;

/** 键序无关的 JSON 规范化（propose_op 重复检测用）。 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const src = val as Record<string, unknown>;
      return Object.keys(src)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = src[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/** 字符 bigram Jaccard 相似度（跨轮叙述去重用）。 */
function bigramJaccard(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, "");
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter += 1;
  return inter / (gx.size + gy.size - inter);
}

/** 实测：模型复读的轮次叙述 ≥0.50，正常不同轮次 ≤0.04，取 0.35 两侧留量。 */
const DUPLICATE_ROUND_SIMILARITY = 0.35;

/** 跨轮叙述折叠：与任一保留轮次高度相似的整轮文本不入最终消息（spec 行不受影响）。 */
function collapseRepeatedRounds(
  parts: { round: number; delta: string }[],
  roundCount: number,
): string {
  const byRound = new Map<number, string>();
  for (const p of parts) {
    byRound.set(p.round, (byRound.get(p.round) ?? "") + p.delta);
  }
  const dropped = new Set<number>();
  const kept: string[] = [];
  for (let r = 0; r < roundCount; r++) {
    const text = byRound.get(r);
    if (text === undefined || text.length === 0) continue;
    if (kept.some((prev) => bigramJaccard(prev, text) >= DUPLICATE_ROUND_SIMILARITY)) {
      dropped.add(r);
      continue;
    }
    kept.push(text);
  }
  return parts.filter((p) => !dropped.has(p.round)).map((p) => p.delta).join("");
}

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
  db: Database.Database;
  llm: LLMClient;
  content: string;
  /** 可注入的新闻检索（测试用）；默认按需抓取的真实服务。 */
  newsSearch?: (q: SearchNewsQuery) => Promise<NewsSearchResult>;
  /** 取消探测（如客户端断开）：返回 true 即停止生成，已产出内容照常落库 */
  isCancelled?: () => boolean;
}): AsyncIterable<AgentEvent> {
  const { db, llm, content } = opts;
  const messages = createMessagesService(db);
  const ops = createOpsService(db);
  const newsSearch =
    opts.newsSearch ??
    createNewsService({ db, llm, fetchers: buildSourceFetchers() }).searchNews;

  // 回合级自动取消：启动时已存在的 pending 提议，若本轮既未确认（尝试过但失败不算）
  // 也未被新建提议取代 → 用户已转向其他任务，回合结束自动取消（卡片经对账信号翻转）
  const startPendingId = ops
    .getRecentOpsSummary(5)
    .find((o) => o.status === "pending")?.op_id;
  const createdOpIds = new Set<string>();
  let attemptedExecute = false;

  messages.appendMessage({ role: "user", contentText: content });
  const { system, messages: history } = buildContext(db);

  const splitter = createSpecSplitter();
  /** 文本增量带轮次标签：跨轮叙述折叠的最小单元（行缓冲会把多轮散文并成一个 delta，
   *  必须靠每轮末的 splitter.flushLine() 制造边界，见循环内）。 */
  const textParts: { round: number; delta: string }[] = [];
  const specLines: string[] = [];
  const convo: ModelMsg[] = [...history];
  const retries = new Map<string, number>();
  let currentRound = 0;

  function* emitSplit(events: Iterable<{ kind: string; delta?: string; line?: string }>) {
    for (const ev of events) {
      if (ev.kind === "text" && ev.delta !== undefined) {
        textParts.push({ round: currentRound, delta: ev.delta });
        yield { type: "text", delta: ev.delta } as AgentEvent;
      } else if (ev.kind === "spec" && ev.line !== undefined) {
        specLines.push(ev.line);
        yield { type: "spec", line: ev.line } as AgentEvent;
      }
    }
  }

  async function executeTool(call: ToolCall): Promise<string> {
    try {
      return await executeToolInner(call);
    } catch (err) {
      // I1：执行异常回喂模型自查纠正，不击穿整轮对话
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "工具执行失败",
      });
    }
  }

  async function executeToolInner(call: ToolCall): Promise<string> {
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

    const a = args as Record<string, unknown>;
    switch (call.name) {
      case "query_bills": {
        const q = a as unknown as z.infer<typeof argSchemas.query_bills>;
        const items = listBills(db, {
          from: q.from,
          to: q.to,
          category: q.category,
          type: q.type,
          kw: q.q,
          limit: q.limit ?? 20,
        });
        return JSON.stringify({ ok: true, items });
      }
      case "bills_stats": {
        const s = a as unknown as z.infer<typeof argSchemas.bills_stats>;
        const items = billStats(db, {
          from: s.from,
          to: s.to,
          type: s.type,
          groupBy: s.group_by,
          level: s.level,
        });
        return JSON.stringify({ ok: true, items });
      }
      case "propose_op": {
        const p = a as unknown as { kind: OpAction; payload: Record<string, unknown> };
        // 工具循环防护：模型不稳定时会反复 propose 相同内容（每轮开场白被跨轮累积成复读文本，
        // 且旧提议被 supersede 成 expired 垃圾）。同 kind+payload 的 pending 已存在时复用之，
        // 并用强指令把模型拉回「输出 spec 卡片」这一步。
        const existing = ops
          .getRecentOpsSummary(10)
          .find(
            (o) =>
              o.status === "pending" && o.kind === p.kind && stableJson(o.payload) === stableJson(p.payload),
          );
        if (existing) {
          createdOpIds.add(existing.op_id);
          return JSON.stringify({
            ok: true,
            duplicate: true,
            op_id: existing.op_id,
            kind: p.kind,
            payload: p.payload,
            hint: "该提议已存在（重复调用 propose_op 不会创建新提议）。禁止再调用任何工具；立即输出 ```spec 代码块：/root 指向一个 BillConfirmCard 元素，props 必须包含此 op_id 与 status=\"pending\"，然后正常结束。",
          });
        }
        const proposal = ops.proposeOp(p.kind, p.payload);
        createdOpIds.add(proposal.op_id);
        return JSON.stringify({
          ok: true,
          op_id: proposal.op_id,
          kind: proposal.kind,
          payload: p.payload,
          hint: "提议已创建。立即输出 ```spec 代码块：/root 指向一个 BillConfirmCard 元素（props 含上述 op_id 与 status=\"pending\"），不要再调用任何工具。",
        });
      }
      case "execute_op": {
        attemptedExecute = true;
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
          const data = outcome.data as { bill: import("../../../features/bills/server/bills.service").Bill; deleted?: boolean };
          // quip 转后台生成补写，工具立即返回（不拖慢回合与卡片对账信号）
          storeResult(db, p.op_id, { bill: data.bill, deleted: data.deleted }, null);
          attachQuipInBackground(db, llm, p.op_id, data.bill);
          return JSON.stringify({ ok: true, status: outcome.status, bill: data.bill });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : "执行失败",
          });
        }
      }
      case "search_news": {
        const n = a as unknown as z.infer<typeof argSchemas.search_news>;
        const keywords = n.keywords ?? [];
        const mode = n.mode === "hot" ? "hot" : keywords.length > 0 ? "keyword" : "hot";
        try {
          const result = await newsSearch({
            keywords,
            mode,
            source: n.source as SourceId | undefined,
            from: n.from,
            to: n.to,
            limit: n.limit,
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
  let cancelled = false;

  for (let round = 0; round < MAX_ROUNDS && !cancelled; round++) {
    currentRound = round;
    let calls: ToolCall[] = [];
    let roundText = "";

    for await (const delta of llm.stream({ system, messages: convo, tools: TOOL_DEFS })) {
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }
      if (delta.type === "text") {
        roundText += delta.delta;
        yield* emitSplit(splitter.feed(delta.delta));
      } else {
        calls = delta.calls;
      }
    }
    if (cancelled) break;

    // 轮次边界：把行缓冲里的散文立即吐出并归入本轮，跨轮叙述才可按轮折叠
    yield* emitSplit(splitter.flushLine());

    if (calls.length === 0) {
      break;
    }

    // 回喂：assistant(tool_calls) + 每个 tool 的结果
    convo.push({ role: "assistant", content: roundText, tool_calls: calls });
    for (const call of calls) {
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }
      yield { type: "tool", name: call.name };
      const result = await executeTool(call);
      convo.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  // 取消时也 flush：尾部半行文本属于已产出内容，随部分回复一起落库
  yield* emitSplit(splitter.end());

  const contentText = collapseRepeatedRounds(textParts, currentRound + 1);
  if (!cancelled || contentText.length > 0 || specLines.length > 0) {
    const saved = messages.appendMessage({
      role: "assistant",
      contentText,
      specJson: specLines.length > 0 ? JSON.stringify(specLines) : null,
    });
    finalMessage = { id: saved.id };
  }

  if (!cancelled) {
    yield { type: "done", message: finalMessage };
  }

  // 用户切换任务：启动时的 pending 提议本轮未被确认/取代/尝试确认 → 自动取消
  if (
    !cancelled &&
    startPendingId &&
    !attemptedExecute &&
    !createdOpIds.has(startPendingId)
  ) {
    const stillPending = ops.getOps([startPendingId])[0];
    if (stillPending && stillPending.status === "pending") {
      ops.cancelOp(startPendingId);
    }
  }
}
