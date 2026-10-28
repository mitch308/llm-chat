import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../../../server/src/db/connection";
import { createFakeLLM } from "../../../server/src/chat/llm";
import { createApp } from "../../../server/src/app";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-news-routes-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** REST 契约（行为保持修复）：app.ts 必须把 llm 线程透传给 news 路由，
 *  否则注入 llm 的调用方（翻译/摘要）经 REST 路径静默消失。
 *  防网络：仅查 hackernews 单源且缓存新鲜（fetched_at=now → 零抓取），
 *  正文抽取的 url 指向本机拒绝端口（连接立即失败 → 降级 RSS description）。 */
describe("GET /api/news/search（app 级 llm 线程）", () => {
  it("注入 fake llm 时外文条目经 REST 路径走 translateAndSummarize", async () => {
    db.prepare(
      `INSERT INTO news_items (source, external_id, title, url, published_at, heat_score, fetched_at, description)
       VALUES ('hackernews', 'hn-1', 'Big AI Release', 'http://127.0.0.1:1/hn-1', '2026-10-27T08:00:00Z', 10, datetime('now'), 'A short story about AI.')`,
    ).run();
    const app = createApp({
      db,
      llm: createFakeLLM([
        [
          {
            type: "text",
            delta: JSON.stringify([
              { external_id: "hn-1", title_zh: "AI 大发布", summary_zh: "某公司发布新模型，性能大幅提升。" },
            ]),
          },
        ],
      ]),
    });

    const res = await request(app).get("/api/news/search?q=AI&source=hackernews");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title_zh).toBe("AI 大发布");
    expect(res.body.items[0].summary_zh).toBe("某公司发布新模型，性能大幅提升。");
  });
});
