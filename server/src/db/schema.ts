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

/** FTS5 可用时建全文索引虚拟表；不可用则跳过（检索降级 LIKE）。 */
export const DDL_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(title, title_zh, content='news_items', content_rowid='id')`;
