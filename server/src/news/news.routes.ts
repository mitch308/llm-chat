import type Database from "better-sqlite3";
import { Router } from "express";
import { createNewsService } from "../../../features/news/server/news.service";
import { buildSourceFetchers, SOURCE_IDS } from "../../../features/news/server/fetchers";
import type { SourceId } from "../../../features/news/server/sources";
import type { LLMClient } from "../chat/llm";

/** GET /api/news/search 与 /api/news/sources（按需抓取，无任何定时任务）。 */
export function newsRoutes(db: Database.Database, llm?: LLMClient): Router {
  const svc = createNewsService({ db, llm, fetchers: buildSourceFetchers() });
  const router = Router();

  router.get("/news/search", async (req, res) => {
    const mode = req.query.mode === "hot" ? "hot" : "keyword";
    const keywords = String(req.query.q ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const source = req.query.source ? String(req.query.source) : undefined;
    if (source && !SOURCE_IDS.includes(source as SourceId)) {
      res.status(400).json({ code: "BAD_SOURCE", message: `未知来源: ${source}` });
      return;
    }
    if (mode === "keyword" && keywords.length === 0) {
      res.status(400).json({ code: "BAD_REQUEST", message: "关键词模式需要 q 参数" });
      return;
    }
    try {
      const result = await svc.searchNews({
        keywords,
        mode,
        source: source as SourceId | undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        code: "INTERNAL",
        message: err instanceof Error ? err.message : "查询失败",
      });
    }
  });

  router.get("/news/sources", (_req, res) => {
    res.json({ items: svc.sourcesHealth() });
  });

  return router;
}
