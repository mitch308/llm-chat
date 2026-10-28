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
