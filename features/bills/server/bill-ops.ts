import type Database from "better-sqlite3";
import { z } from "zod";
import { writeOpResult, type LLMClient, type OpHandler } from "@llm-chat/features/server";
import { attachQuip, mergeQuipIntoResult } from "./quip";
import { OpRunError, type RunResult } from "../../../server/src/ops/ops.service";
import {
  createBill,
  deleteBill,
  getBill,
  updateBill,
  type Bill,
} from "./bills.service";
import { attachQuipInBackground } from "./quip";

export type OpAction = "bill_create" | "bill_update" | "bill_delete";

/** 类目名 → 叶子 id：叶子直接用；父类优先匹配 item 中出现的叶子名，否则第一个叶子。 */
export function resolveLeafCategoryId(db: Database.Database, name: string, item: string): number {
  const cat = db.prepare(`SELECT * FROM categories WHERE name = ?`).get(name) as
    | { id: number; parent_id: number | null }
    | undefined;
  if (!cat) throw new OpRunError("BAD_CATEGORY", `类目不存在: ${name}`);
  if (cat.parent_id !== null) return cat.id;

  const leaves = db
    .prepare(`SELECT id, name FROM categories WHERE parent_id = ? ORDER BY id`)
    .all(cat.id) as { id: number; name: string }[];
  if (leaves.length === 0) return cat.id;
  const matched = leaves.find((l) => item.includes(l.name));
  return (matched ?? leaves[0]).id;
}

export const yuanToCents = (yuan: number) => Math.round(yuan * 100);

/** 当月起止日期（基于账单 date 的月份）。 */
export function monthRange(dateStr: string): { from: string; to: string } {
  const [y, m] = dateStr.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/** executeOp 的 run 回调：payload 校验 + 写库。动作路由与 AGENT execute_op 共用。 */
export function runBillAction(
  db: Database.Database,
  name: OpAction,
  payload: Record<string, unknown>,
): RunResult {
  if (name === "bill_create") {
    const type = payload.type === "income" ? "income" : "expense";
    if (typeof payload.amount_yuan !== "number" || !(payload.amount_yuan > 0)) {
      return { ok: false, code: "VALIDATION", message: "金额不合法" };
    }
    if (typeof payload.item !== "string" || !payload.item.trim()) {
      return { ok: false, code: "VALIDATION", message: "事项不能为空" };
    }
    if (typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
      return { ok: false, code: "VALIDATION", message: "日期须为 YYYY-MM-DD" };
    }
    if (typeof payload.category !== "string") {
      return { ok: false, code: "VALIDATION", message: "缺少类目" };
    }
    const categoryId = resolveLeafCategoryId(db, payload.category, payload.item);
    const bill = createBill(db, {
      type,
      amountCents: yuanToCents(payload.amount_yuan),
      item: payload.item.trim(),
      categoryId,
      date: payload.date,
      note: typeof payload.note === "string" ? payload.note : undefined,
    });
    return { ok: true, data: { bill } };
  }

  const id = Number(payload.id);
  if (!Number.isInteger(id)) {
    return { ok: false, code: "VALIDATION", message: "缺少账单 id" };
  }
  if (name === "bill_update") {
    const patch: Record<string, unknown> = {};
    if (payload.amount_yuan !== undefined) {
      patch.amountCents = yuanToCents(Number(payload.amount_yuan));
    }
    if (payload.item !== undefined) patch.item = String(payload.item);
    if (payload.category !== undefined) {
      patch.categoryId = resolveLeafCategoryId(
        db,
        String(payload.category),
        String(payload.item ?? ""),
      );
    }
    if (payload.date !== undefined) patch.date = String(payload.date);
    const bill = updateBill(db, id, patch);
    return { ok: true, data: { bill } };
  }
  // bill_delete
  const existing = getBill(db, id);
  if (!existing) return { ok: false, code: "NOT_FOUND", message: `账单 ${id} 不存在` };
  deleteBill(db, id);
  return { ok: true, data: { bill: existing, deleted: true } };
}

/** propose_op 的 payload 校验（原 agent.ts argSchemas.propose_op.payload 逐字迁移）。 */
const billOpPayload = z
  .object({
    type: z.enum(["expense", "income"]).optional(),
    amount_yuan: z.number().positive(),
    item: z.string().min(1),
    category: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().optional(),
    id: z.number().int().optional(),
  })
  .passthrough();

/** Bill 行 → BillConfirmCard props.data（amount_cents 还原为元，类目用展示名）。 */
function billCardData(bill: Bill) {
  return {
    type: bill.type,
    amount_yuan: bill.amount_cents / 100,
    item: bill.item,
    category: bill.categoryName,
    date: bill.date,
    note: bill.note,
  };
}

/** 疑似重复（spec 8.4 第 4 步：同金额+同类目+同日期已存在 → 卡片提醒，仍允许确认）。 */
function hasSimilarBill(db: Database.Database, payload: Record<string, unknown>): boolean {
  try {
    const categoryId = resolveLeafCategoryId(db, String(payload.category), String(payload.item));
    const row = db
      .prepare(`SELECT 1 FROM bills WHERE amount_cents = ? AND category_id = ? AND date = ? LIMIT 1`)
      .get(yuanToCents(Number(payload.amount_yuan)), categoryId, String(payload.date));
    return row !== undefined;
  } catch {
    return false; // 类目解析不了交给 execute 报错，卡片不给 warning
  }
}

/** 按 kind 闭包分发：三种账单动作共用一套 payload 校验与后置流程，
 *  仅 execute 落到不同的 runBillAction 分支。 */
export function billOpHandler(kind: OpAction): OpHandler {
  return {
    argPayload: billOpPayload,
    execute: (payload, env) => runBillAction(env.db, kind, payload),
    afterExecute: async ({ db, llm, opId }, data) => {
      // 结果先落 {data, quip:null}；quip 生成（内含 15s 超时兜底）作为确认后附言返回，
      // 由调用方决定去处（agent 文本通道出文本 / 动作路由后台落一条文本消息）
      writeOpResult(db, opId, data, null);
      const quip = await attachQuip(db, llm, (data as { bill: Bill }).bill);
      if (quip) mergeQuipIntoResult(db, opId, quip);
      // 附言兜底：quip 失败/超时也必须有可见确认反馈，绝不产生空气泡
      return quip ?? (kind === "bill_delete" ? "已删除 ✅" : "已保存 ✅");
    },
    /** propose_op 成功后的确认语：模型在 propose 轮保持沉默，由 agent 补进消息文本
     *  （措辞机械生成，从根上杜绝"新记被说成修改"）。 */
    proposeNarration: (input) => {
      const p = input.payload as {
        item?: string;
        amount_yuan?: number;
        category?: string;
        date?: string;
      };
      if (kind === "bill_create") {
        return `好的，帮你记下一笔：${p.item ?? ""} ¥${p.amount_yuan ?? ""}（${p.category ?? ""}，${p.date ?? ""}），请确认。`;
      }
      if (kind === "bill_delete") {
        return "好的，确认后删除这笔账单，请确认。";
      }
      return "好的，帮你修改这笔账单，请确认下方变更内容。";
    },
    cardHint: {
      created:
        '提议已创建。立即输出 ```spec 代码块：/root 指向一个 BillConfirmCard 元素（props 含上述 op_id 与 status="pending"），不要再调用任何工具。',
      duplicate:
        '该提议已存在（重复调用 propose_op 不会创建新提议）。禁止再调用任何工具；立即输出 ```spec 代码块：/root 指向一个 BillConfirmCard 元素，props 必须包含此 op_id 与 status="pending"，然后正常结束。',
    },
    /** cardSpec：propose_op 成功后服务端直出 pending 确认卡片并收尾回合。
     *  executed 态不再出卡片——旧消息的 pending 卡片经 GET /ops 对账翻转，
     *  quip 走 afterExecute 附言以文本消息输出（不进卡片）。 */
    cardSpec: (input, env) => {
      if (input.status !== "pending") return null;
      const p = input.payload;
      let data: Record<string, unknown>;
      let diff: { before: Record<string, unknown> | null; after: Record<string, unknown> | null } | null = null;
      if (kind === "bill_create") {
        data = {
          type: p.type === "income" ? "income" : "expense",
          amount_yuan: p.amount_yuan,
          item: p.item,
          category: p.category,
          date: p.date,
          note: typeof p.note === "string" ? p.note : null,
        };
      } else {
        const before = getBill(env.db, Number(p.id));
        const beforeData = before ? billCardData(before) : null;
        if (kind === "bill_delete") {
          // 删除确认：卡片展示将删除的记录
          data = (beforeData ?? { type: "expense", amount_yuan: 0, item: String(p.item ?? ""), category: String(p.category ?? ""), date: String(p.date ?? ""), note: null }) as Record<string, unknown>;
          diff = { before: beforeData, after: null };
        } else {
          // 修改确认：data 为提议后的新状态，diff 展示 变更前→变更后
          const after: Record<string, unknown> = beforeData ? { ...beforeData } : { type: "expense", note: null };
          if (p.amount_yuan !== undefined) after.amount_yuan = p.amount_yuan;
          if (p.item !== undefined) after.item = p.item;
          if (p.category !== undefined) after.category = p.category;
          if (p.date !== undefined) after.date = p.date;
          if (p.note !== undefined) after.note = typeof p.note === "string" ? p.note : null;
          data = after;
          diff = { before: beforeData, after };
        }
      }
      return {
        type: "BillConfirmCard",
        props: {
          op_id: input.opId,
          kind,
          status: "pending",
          data,
          diff,
          warning:
            kind === "bill_create" && hasSimilarBill(env.db, input.payload)
              ? "今天已有一笔类似记录"
              : null,
        },
      };
    },
  };
}
