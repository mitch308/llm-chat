import type Database from "better-sqlite3";
import { z, type ZodType } from "zod";
import type { LLMClient, ModelMsg, ToolCall, ToolDef } from "../chat/llm";
import { createMessagesService } from "../messages/messages.service";
import { buildContext } from "../chat/context";
import { createSpecSplitter } from "../chat/streamSplitter";
import { createOpsService } from "../ops/ops.service";
import { ASM } from "../features";
import type { OpHandler, ToolEntry } from "@llm-chat/features/server";

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

/** 内核 op 工具定义（propose_op/execute_op）：ops 是核心设施，工具本身内置 agent，
 *  但 kind 清单与 payload 校验/执行体均来自注册表（ASM.ops，feature 贡献）。
 *  def 自原 server/src/agent/tools.ts TOOL_DEFS 逐字迁移，kind enum 改按注册表派生。 */
const OP_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "propose_op",
      description:
        "创建写操作提议（不直接写库）。返回 op_id 用于生成确认卡片。同一时刻只有一个待确认提议，新的会取代旧的",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...ASM.ops.keys()] },
          payload: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["expense", "income"] },
              amount_yuan: { type: "number", description: "金额（元），必须为正数" },
              item: { type: "string", description: "事项，如 午饭/打车/羽绒服" },
              category: { type: "string", description: "叶子类目名，如 三餐/打车/衣服" },
              date: { type: "string", description: "YYYY-MM-DD" },
              note: { type: "string" },
              id: { type: "number", description: "bill_update/bill_delete 时目标账单 id" },
            },
            required: ["amount_yuan", "item", "category", "date"],
          },
        },
        required: ["kind", "payload"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_op",
      description:
        "执行待确认提议。仅当用户对眼前的确认卡片明确文字确认（如「确认/对/保存吧」）时才可调用",
      parameters: {
        type: "object",
        properties: {
          op_id: { type: "string" },
        },
        required: ["op_id"],
      },
    },
  },
];

/** 工具入参 schema（zod）：内核 op 工具用内置 schema，feature 工具查注册表。
 *  propose_op 只校验信封（kind 为自由字符串，注册表 ASM.ops 为权威）；
 *  kind/payload 按 OpHandler（argPayload）在 executeToolInner 的入参校验段
 *  （retries 清零之前）校验，与信封失败共用同一重试升级。 */
const argSchemas = {
  propose_op: z
    .object({
      kind: z.string().min(1),
      payload: z.object({}).passthrough(),
    })
    .strict(),
  execute_op: z.object({ op_id: z.string().min(1) }).strict(),
} as const;

/** 工具入参 schema 查询：内核 op 工具用内置 schema，feature 工具查注册表。 */
function schemaFor(name: string, tools: Map<string, ToolEntry>): ZodType | undefined {
  if (name === "propose_op" || name === "execute_op") return argSchemas[name];
  return tools.get(name)?.schema;
}

/** AGENT 循环：上下文 → 流式输出 → 工具执行回喂 → 落库。 */
export async function* runAgent(opts: {
  db: Database.Database;
  llm: LLMClient;
  content: string;
  /** 工具注册表（feature 贡献，测试可克隆后覆盖个别条目）；默认 ASM.tools。 */
  tools?: Map<string, ToolEntry>;
  /** 取消探测（如客户端断开）：返回 true 即停止生成，已产出内容照常落库 */
  isCancelled?: () => boolean;
}): AsyncIterable<AgentEvent> {
  const { db, llm, content } = opts;
  const tools = opts.tools ?? ASM.tools;
  const messages = createMessagesService(db);
  const ops = createOpsService(db);

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
    const schema = schemaFor(call.name, tools);
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

    // propose_op：kind（注册表键）与 payload（OpHandler.argPayload）校验。
    // 必须放在下方 retries.delete 之前——信封通过即清零会让计数永远停在 1，
    // fatal 升级不可达、模型复读非法入参直到 MAX_ROUNDS（回归修复）。
    let opHandler: OpHandler | undefined;
    if (call.name === "propose_op") {
      const p = args as unknown as { kind: string; payload: Record<string, unknown> };
      opHandler = ASM.ops.get(p.kind);
      if (!opHandler) {
        const used = (retries.get(call.name) ?? 0) + 1;
        retries.set(call.name, used);
        if (used > MAX_TOOL_RETRIES) {
          return JSON.stringify({ ok: false, error: "入参多次不合法，放弃该工具", fatal: true });
        }
        return JSON.stringify({ ok: false, error: `未知提议类型: ${p.kind}` });
      }
      const parsedPayload = opHandler.argPayload.safeParse(p.payload);
      if (!parsedPayload.success) {
        const used = (retries.get(call.name) ?? 0) + 1;
        retries.set(call.name, used);
        if (used > MAX_TOOL_RETRIES) {
          return JSON.stringify({ ok: false, error: "入参多次不合法，放弃该工具", fatal: true });
        }
        return JSON.stringify({
          ok: false,
          error: `入参不合法: ${parsedPayload.error.issues.map((i) => i.message).join("; ")}`,
        });
      }
      args = { kind: p.kind, payload: parsedPayload.data };
    }
    retries.delete(call.name);

    const a = args as Record<string, unknown>;
    switch (call.name) {
      case "propose_op": {
        const p = a as unknown as { kind: string; payload: Record<string, unknown> };
        const handler = opHandler!; // kind 与 payload 已在入参校验段通过（含重试升级）
        const payload = p.payload;
        // 工具循环防护：模型不稳定时会反复 propose 相同内容（每轮开场白被跨轮累积成复读文本，
        // 且旧提议被 supersede 成 expired 垃圾）。同 kind+payload 的 pending 已存在时复用之，
        // 并用强指令把模型拉回「输出 spec 卡片」这一步。
        const existing = ops
          .getRecentOpsSummary(10)
          .find(
            (o) =>
              o.status === "pending" && o.kind === p.kind && stableJson(o.payload) === stableJson(payload),
          );
        if (existing) {
          createdOpIds.add(existing.op_id);
          return JSON.stringify({
            ok: true,
            duplicate: true,
            op_id: existing.op_id,
            kind: p.kind,
            payload,
            hint: handler.cardHint?.duplicate,
          });
        }
        const proposal = ops.proposeOp(p.kind, payload);
        createdOpIds.add(proposal.op_id);
        return JSON.stringify({
          ok: true,
          op_id: proposal.op_id,
          kind: proposal.kind,
          payload,
          hint: handler.cardHint?.created,
        });
      }
      case "execute_op": {
        attemptedExecute = true;
        const p = a as unknown as { op_id: string };
        const proposal = ops.getOps([p.op_id])[0];
        if (!proposal) return JSON.stringify({ ok: false, error: "提议不存在" });
        const handler = ASM.ops.get(proposal.kind);
        if (!handler) {
          return JSON.stringify({ ok: false, error: `未知提议类型: ${proposal.kind}` });
        }
        try {
          const outcome = await ops.executeOp(p.op_id, async (payload) =>
            handler.execute(payload as Record<string, unknown>, { db, llm }),
          );
          if (outcome.status === "invalid") {
            return JSON.stringify({ ok: false, error: outcome.message });
          }
          const data = outcome.data as Record<string, unknown>;
          // handler 后置（写结果 + quip 转后台生成补写），工具立即返回（不拖慢回合与卡片对账信号）
          handler.afterExecute?.({ db, llm, opId: p.op_id }, data);
          return JSON.stringify({ ok: true, status: outcome.status, ...data });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : "执行失败",
          });
        }
      }
      default: {
        // feature 工具：注册表动态分发，执行体由各 feature 贡献（入参已在上方按其 schema 校验）
        const entry = tools.get(call.name);
        if (!entry) {
          return JSON.stringify({ ok: false, error: `未知工具: ${call.name}` });
        }
        const result = await entry.execute(args, { db, llm });
        // 执行体约定返回 JSON 字符串（与原内置 case 一致）；兜底对象也直接序列化
        return typeof result === "string" ? result : JSON.stringify(result);
      }
    }
  }

  let finalMessage: { id: number } | undefined;
  let cancelled = false;

  // 模型侧工具清单 = 内核 op 工具 + 注册表（feature 贡献）工具
  const toolDefs: ToolDef[] = [...OP_TOOL_DEFS, ...[...tools.values()].map((t) => t.def)];

  for (let round = 0; round < MAX_ROUNDS && !cancelled; round++) {
    currentRound = round;
    let calls: ToolCall[] = [];
    let roundText = "";

    for await (const delta of llm.stream({ system, messages: convo, tools: toolDefs })) {
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
