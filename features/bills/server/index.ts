import { defineServerFeature } from "@llm-chat/features/server";
import { seedCategories } from "./seeds";

/** bills feature 数据层注册：DDL（categories 先于 bills，FK 依赖）+ 两级类目种子。 */
export default defineServerFeature("bills", (ctx) => {
  ctx.ddl([
    `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id),
    kind TEXT NOT NULL CHECK (kind IN ('expense','income'))
  )`,

    `CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('expense','income')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    item TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    date TEXT NOT NULL CHECK (length(date) = 10),
    note TEXT,
    source_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    `CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(date)`,
    `CREATE INDEX IF NOT EXISTS idx_bills_category ON bills(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bills_type ON bills(type)`,
  ]);
  ctx.seed(seedCategories);
});
