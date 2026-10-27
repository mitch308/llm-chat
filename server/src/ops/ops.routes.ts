import type Database from "better-sqlite3";
import { Router } from "express";
import type { Bill } from "../bills/bills.service";
import { createOpsService, OpRunError } from "./ops.service";
import { attachQuip, runBillAction, storeResult, type OpAction } from "./ops.executor";
import { createZhipuClient, type LLMClient } from "../chat/llm";

/** POST /api/actions/:name（确认按钮）+ GET /api/ops?op_ids=。 */
export function opsRoutes(db: Database, llm?: LLMClient): Router {
  const ops = createOpsService(db);
  const router = Router();

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
      const outcome = await ops.executeOp(opId, async (payload) =>
        runBillAction(db, name as OpAction, payload as Record<string, unknown>),
      );

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
        const stored = JSON.parse(ops.getOps([opId])[0]?.result_json ?? "{}") as {
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
      const client = llm ?? createZhipuClient({ apiKey: process.env.ZHIPU_API_KEY ?? "" });
      const quip = await attachQuip(db, client, data.bill);
      storeResult(db, opId, { bill: data.bill, deleted: data.deleted }, quip);
      res.json({
        status: "executed",
        bill: data.bill,
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
