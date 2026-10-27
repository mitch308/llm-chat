import type Database from "better-sqlite3";
import { Router } from "express";
import { createMessagesService } from "./messages.service";

/** GET /api/messages?before_id=&limit= → {items}（升序，供前端直接展示）。 */
export function messagesRoutes(db: Database): Router {
  const svc = createMessagesService(db);
  const router = Router();

  router.get("/messages", (req, res) => {
    const beforeId = req.query.before_id ? Number(req.query.before_id) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (
      (beforeId !== undefined && (!Number.isInteger(beforeId) || beforeId <= 0)) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
    ) {
      res.status(400).json({ code: "BAD_REQUEST", message: "before_id 与 limit 须为正整数" });
      return;
    }
    const items = svc.listMessages({ beforeId, limit }).reverse();
    res.json({ items });
  });

  return router;
}
