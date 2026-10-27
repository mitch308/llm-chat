import type Database from "better-sqlite3";
import { Router } from "express";
import { runAgent } from "../agent/agent";
import { createZhipuClient, type LLMClient } from "./llm";

/** POST /api/chat {content} → SSE 流（text/spec/tool/done 事件）。 */
export function chatRoutes(db: Database, llm?: LLMClient): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ code: "BAD_REQUEST", message: "content 不能为空" });
      return;
    }

    let client: LLMClient;
    try {
      client = llm ?? createZhipuClient({ apiKey: process.env.ZHIPU_API_KEY ?? "" });
    } catch {
      res
        .status(500)
        .json({ code: "NO_API_KEY", message: "未配置 ZHIPU_API_KEY，无法对话" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      for await (const event of runAgent({ db, llm: client, content })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : "LLM 调用失败",
        })}\n\n`,
      );
    }
    res.end();
  });

  return router;
}
