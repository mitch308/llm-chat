import type Database from "better-sqlite3";
import { Router } from "express";
import {
  billStats,
  createBill,
  deleteBill,
  getBill,
  listBills,
  updateBill,
} from "./bills.service";

function bad(res: unknown, message: string): void {
  (res as { status: (n: number) => { json: (b: unknown) => void } })
    .status(400)
    .json({ code: "VALIDATION", message });
}

export function billsRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/bills", (req, res) => {
    try {
      const items = listBills(db, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        category: req.query.category as string | undefined,
        type: req.query.type as string | undefined,
        kw: req.query.q as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items });
    } catch (err) {
      bad(res, err instanceof Error ? err.message : "查询失败");
    }
  });

  router.get("/bills/stats", (req, res) => {
    const groupBy = req.query.groupBy as string;
    if (groupBy !== "category" && groupBy !== "date") {
      bad(res, "groupBy 须为 category 或 date");
      return;
    }
    try {
      const items = billStats(db, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        type: req.query.type as string | undefined,
        groupBy,
        level: req.query.level as "parent" | "leaf" | undefined,
      });
      res.json({ items });
    } catch (err) {
      bad(res, err instanceof Error ? err.message : "统计失败");
    }
  });

  router.post("/bills", (req, res) => {
    const b = req.body ?? {};
    if (
      (b.type !== "expense" && b.type !== "income") ||
      typeof b.amountCents !== "number" ||
      typeof b.item !== "string" ||
      !b.item.trim() ||
      typeof b.categoryId !== "number" ||
      typeof b.date !== "string"
    ) {
      bad(res, "字段不合法（type/amountCents/item/categoryId/date）");
      return;
    }
    try {
      const bill = createBill(db, {
        type: b.type,
        amountCents: b.amountCents,
        item: b.item.trim(),
        categoryId: b.categoryId,
        date: b.date,
        note: typeof b.note === "string" ? b.note : undefined,
        sourceMessageId: typeof b.sourceMessageId === "number" ? b.sourceMessageId : undefined,
      });
      res.status(201).json(bill);
    } catch (err) {
      bad(res, err instanceof Error ? err.message : "创建失败");
    }
  });

  router.patch("/bills/:id", (req, res) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (b.amountCents !== undefined) patch.amountCents = b.amountCents;
    if (b.item !== undefined) patch.item = b.item;
    if (b.categoryId !== undefined) patch.categoryId = b.categoryId;
    if (b.date !== undefined) patch.date = b.date;
    if (b.note !== undefined) patch.note = b.note;
    try {
      res.json(updateBill(db, id, patch));
    } catch (err) {
      const message = err instanceof Error ? err.message : "更新失败";
      if (message.includes("不存在")) {
        res.status(404).json({ code: "NOT_FOUND", message });
      } else {
        bad(res, message);
      }
    }
  });

  router.delete("/bills/:id", (req, res) => {
    try {
      deleteBill(db, Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: err instanceof Error ? err.message : "删除失败",
      });
    }
  });

  return router;
}

export { getBill };
