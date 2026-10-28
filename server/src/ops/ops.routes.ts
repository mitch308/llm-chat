import type Database from "better-sqlite3";
import { Router } from "express";
import { readOpResult, type OpHandler } from "@llm-chat/features/server";
import { createOpsService, OpRunError } from "./ops.service";
import { getDefaultLLMClient, type LLMClient } from "../chat/llm";

/** POST /api/actions/:name（确认按钮）+ GET /api/ops?op_ids=。
 *  动作按 handlers（ASM.ops，feature 贡献）分发；cancel_op 为核心内置动作。 */
export function opsRoutes(
  db: Database.Database,
  llm?: LLMClient,
  handlers: ReadonlyMap<string, OpHandler> = new Map(),
): Router {
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

    const handler = handlers.get(name);
    if (!handler) {
      res.status(404).json({ code: "NOT_FOUND", message: `未知动作: ${name}` });
      return;
    }

    // C1 双保险：动作名必须与提议的 kind 一致，杜绝"确认删除却新建"
    const proposal = ops.getOps([opId])[0];
    if (!proposal) {
      res.status(409).json({ code: "OP_NOT_FOUND", message: "提议不存在" });
      return;
    }
    if (name !== proposal.kind) {
      res.status(409).json({
        code: "OP_KIND_MISMATCH",
        message: `动作类型不匹配：该提议为 ${proposal.kind}，收到 ${name}`,
      });
      return;
    }

    try {
      const outcome = await ops.executeOp(opId, async (payload) =>
        handler.execute(payload, { db, llm }),
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
        const stored = readOpResult(db, opId);
        const data = (stored.data ?? {}) as Record<string, unknown>;
        res.json({
          ...data,
          status: "already",
          deleted: data.deleted ?? false,
          quip: stored.quip ?? null,
        });
        return;
      }

      // executed：handler 后置（写结果 + quip 转后台生成，实测首 token ~13s，不能阻塞确认响应）
      const data = outcome.data as Record<string, unknown>;
      handler.afterExecute?.({ db, llm: llm ?? getDefaultLLMClient(), opId }, data);
      res.json({
        ...data,
        status: "executed",
        deleted: data.deleted ?? false,
        quip: null,
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
