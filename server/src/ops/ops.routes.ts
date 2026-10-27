import type Database from "better-sqlite3";
import { Router } from "express";
import {
  createBill,
  deleteBill,
  getBill,
  updateBill,
  type Bill,
} from "../bills/bills.service";
import { createOpsService, OpRunError } from "./ops.service";
import { generateQuip } from "./quip";
import { createZhipuClient, type LLMClient } from "../chat/llm";

/** 类目名 → 叶子 id：叶子直接用；父类优先匹配 item 中出现的叶子名，否则第一个叶子。 */
function resolveLeafCategoryId(db: Database, name: string, item: string): number {
  const cat = db.prepare(`SELECT * FROM categories WHERE name = ?`).get(name) as
    | { id: number; parent_id: number | null }
    | undefined;
  if (!cat) throw new OpRunError("BAD_CATEGORY", `类目不存在: ${name}`);
  if (cat.parent_id !== null) return cat.id; // 已是叶子

  const leaves = db
    .prepare(`SELECT id, name FROM categories WHERE parent_id = ? ORDER BY id`)
    .all(cat.id) as { id: number; name: string }[];
  if (leaves.length === 0) return cat.id; // 无子类的单级类目（收入）
  const matched = leaves.find((l) => item.includes(l.name));
  return (matched ?? leaves[0]).id;
}

const yuanToCents = (yuan: number) => Math.round(yuan * 100);

/** 当月（Asia/Shanghai）起止日期。 */
function monthRange(dateStr: string): { from: string; to: string } {
  const [y, m] = dateStr.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

export function opsRoutes(db: Database, llm?: LLMClient): Router {
  const ops = createOpsService(db);
  const router = Router();

  async function withQuip(kind: string, bill: Bill): Promise<{ bill: Bill; quip: string | null }> {
    const client =
      llm ??
      createZhipuClient({ apiKey: process.env.ZHIPU_API_KEY ?? "" });
    try {
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
      const quip = await generateQuip(
        {
          bill,
          monthCategoryTotalCents: monthCat.total,
          monthCategoryCount: monthCat.n,
          monthTotalCents: monthTotal,
        },
        client,
      );
      return { bill, quip };
    } catch {
      return { bill, quip: null };
    }
  }

  function storeQuip(opId: string, data: object, quip: string | null): void {
    db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
      JSON.stringify({ data, quip }),
      opId,
    );
  }

  router.post("/actions/:name", async (req, res) => {
    const name = req.params.name;
    const opId = req.body?.op_id;
    if (typeof opId !== "string" || opId.length === 0) {
      res.status(400).json({ code: "BAD_REQUEST", message: "op_id 必填" });
      return;
    }

    if (name === "cancel_op") {
      const row = ops.getOps([opId])[0];
      if (!row) {
        res.status(409).json({ code: "OP_NOT_FOUND", message: "提议不存在" });
        return;
      }
      ops.cancelOp(opId);
      res.json({ status: "cancelled" });
      return;
    }

    if (name !== "bill_create" && name !== "bill_update" && name !== "bill_delete") {
      res.status(404).json({ code: "NOT_FOUND", message: `未知动作: ${name}` });
      return;
    }

    try {
      const outcome = await ops.executeOp(opId, async (payload) => {
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
            patch.categoryId = resolveLeafCategoryId(db, String(payload.category), String(payload.item ?? ""));
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
      });

      if (outcome.status === "invalid") {
        const codeMap = {
          expired: "OP_EXPIRED",
          cancelled: "OP_CANCELLED",
          not_found: "OP_NOT_FOUND",
        } as const;
        res.status(409).json({ code: codeMap[outcome.reason], message: outcome.message });
        return;
      }

      if (outcome.status === "already") {
        const stored = JSON.parse(
          ops.getOps([opId])[0]?.result_json ?? "{}",
        ) as {
          data?: { bill: Bill; deleted?: boolean };
          quip?: string | null;
        };
        res.json({
          status: "already",
          bill: stored.data?.bill ?? null,
          deleted: stored.data?.deleted ?? false,
          quip: stored.quip ?? null,
        });
        return;
      }

      // executed：生成俏皮话并写回 result_json
      const data = outcome.data as { bill: Bill; deleted?: boolean };
      const { bill, quip } = await withQuip(name, data.bill);
      storeQuip(opId, { bill: data.bill, deleted: data.deleted }, quip);
      res.json({
        status: "executed",
        bill,
        deleted: data.deleted ?? false,
        quip,
      });
    } catch (err) {
      if (err instanceof OpRunError) {
        res.status(400).json({ code: err.code, message: err.message });
        return;
      }
      res.status(500).json({
        code: "INTERNAL",
        message: err instanceof Error ? err.message : "执行失败",
      });
    }
  });

  router.get("/ops", (req, res) => {
    const ids = String(req.query.op_ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    res.json({ items: ops.getOps(ids) });
  });

  return router;
}
