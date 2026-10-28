import type Database from "better-sqlite3";
import {
  createBill,
  deleteBill,
  getBill,
  updateBill,
  type Bill,
} from "../../../features/bills/server/bills.service";
import { OpRunError, type RunResult } from "./ops.service";
import { generateQuip } from "./quip";
import type { LLMClient } from "../chat/llm";

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

/** 生成俏皮话（真实统计输入；任何失败返回 null）。 */
export async function attachQuip(
  db: Database.Database,
  llm: LLMClient | undefined,
  bill: Bill,
): Promise<string | null> {
  try {
    if (!llm) return null;
    const { from, to } = monthRange(bill.date);
    const monthCat = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
         FROM bills WHERE category_id = ? AND date BETWEEN ? AND ?`,
      )
      .get(bill.category_id, from, to) as { total: number; n: number };
    const monthTotal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bills
           WHERE type = 'expense' AND date BETWEEN ? AND ?`,
        )
        .get(from, to) as { total: number }
    ).total;
    return await generateQuip(
      {
        bill,
        monthCategoryTotalCents: monthCat.total,
        monthCategoryCount: monthCat.n,
        monthTotalCents: monthTotal,
      },
      llm,
    );
  } catch {
    return null;
  }
}

/** 把执行结果（含 quip）写回提议。 */
export function storeResult(
  db: Database.Database,
  opId: string,
  data: object,
  quip: string | null,
): void {
  db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
    JSON.stringify({ data, quip }),
    opId,
  );
}

/** quip 后台生成完成后补写进已存的 result_json（不动 data 载荷）。 */
function mergeQuipIntoResult(db: Database.Database, opId: string, quip: string): void {
  const row = db
    .prepare(`SELECT result_json FROM op_proposals WHERE op_id = ?`)
    .get(opId) as { result_json: string | null } | undefined;
  if (!row) return;
  let parsed: { data?: unknown; quip?: string | null };
  try {
    parsed = JSON.parse(row.result_json ?? "{}") as { data?: unknown; quip?: string | null };
  } catch {
    return; // 存量结果不可解析：宁缺 quip 也不覆盖
  }
  parsed.quip = quip;
  db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
    JSON.stringify(parsed),
    opId,
  );
}

/** fire-and-forget：确认立即返回，quip 生成后补写（glm 实测首 token ~13s，不能同步等）。 */
export function attachQuipInBackground(
  db: Database.Database,
  llm: LLMClient | undefined,
  opId: string,
  bill: Bill,
): void {
  void (async () => {
    try {
      const quip = await attachQuip(db, llm, bill);
      if (quip) mergeQuipIntoResult(db, opId, quip);
    } catch {
      // 后台失败静默：quip 是锦上添花
    }
  })();
}
