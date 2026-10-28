/** DDL，顺序执行；索引与唯一约束随表建立。 */
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content_text TEXT NOT NULL DEFAULT '',
    spec_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`,

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

  `CREATE TABLE IF NOT EXISTS op_proposals (
    op_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bill_create','bill_update','bill_delete')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executed','cancelled','expired')),
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT
  )`,
];

/** FTS5 可用时建全文索引虚拟表（独立内容，rowid 对应 news_items.id）；不可用则跳过（检索降级 LIKE）。 */
export const DDL_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(title, title_zh)`;
