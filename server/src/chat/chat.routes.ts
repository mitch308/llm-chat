import type Database from "better-sqlite3";
import { Router } from "express";
import { createMessagesService } from "../messages/messages.service";
import { buildContext } from "./context";
import { createSpecSplitter } from "./streamSplitter";
import { createZhipuClient, type LLMClient } from "./llm";

function sseEvent(res: unknown, event: Record<string, unknown>): void {
  (res as { write: (s: string) => void }).write(`data: ${JSON.stringify(event)}\n\n`);
}

/** POST /api/chat {content} → SSE 流（text/spec/done 事件）。 */
export function chatRoutes(db: Database, llm?: LLMClient): Router {
  const svc = createMessagesService(db);
  const router = Router();

  router.post("/chat", async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ code: "BAD_REQUEST", message: "content 不能为空" });
      return;
    }

    const client =
      llm ??
      (() => {
        const apiKey = process.env.ZHIPU_API_KEY ?? "";
        return createZhipuClient({ apiKey });
      })();

    svc.appendMessage({ role: "user", contentText: content });
    const { system, messages } = buildContext(db);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const splitter = createSpecSplitter();
    const textParts: string[] = [];
    const specLines: string[] = [];

    const emitSplit = (events: Iterable<{ kind: string; delta?: string; line?: string }>) => {
      for (const ev of events) {
        if (ev.kind === "text" && ev.delta !== undefined) {
          textParts.push(ev.delta);
          sseEvent(res, { type: "text", delta: ev.delta });
        } else if (ev.kind === "spec" && ev.line !== undefined) {
          specLines.push(ev.line);
          sseEvent(res, { type: "spec", line: ev.line });
        }
      }
    };

    try {
      for await (const delta of client.stream({ system, messages, tools: [] })) {
        if (delta.type === "text") {
          emitSplit(splitter.feed(delta.delta));
        }
        // v1 无 tools；tool_calls 忽略
      }
      emitSplit(splitter.end());

      const saved = svc.appendMessage({
        role: "assistant",
        contentText: textParts.join(""),
        specJson: specLines.length > 0 ? JSON.stringify(specLines) : null,
      });
      sseEvent(res, { type: "done", messageId: saved.id });
    } catch (err) {
      sseEvent(res, {
        type: "error",
        message: err instanceof Error ? err.message : "LLM 调用失败",
      });
    }
    res.end();
  });

  return router;
}
