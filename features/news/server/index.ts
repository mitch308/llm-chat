import { defineServerFeature } from "@llm-chat/features/server";

/** news feature 数据层注册：news_items/news_fetch_runs 两表 + FTS5 虚表（不可用降级 LIKE）。 */
export default defineServerFeature("news", (ctx) => {
  ctx.ddl([
    `CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_zh TEXT,
    summary_zh TEXT,
    url TEXT NOT NULL,
    published_at TEXT,
    heat_score INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT,
    UNIQUE(source, external_id)
  )`,
    `CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at)`,

    `CREATE TABLE IF NOT EXISTS news_fetch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','error')),
    item_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`,
  ]);
  // FTS5 可用时建全文索引虚拟表（独立内容，rowid 对应 news_items.id）；不可用则跳过（检索降级 LIKE）。
  ctx.ddlOptional(
    `CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(title, title_zh)`,
  );
});
