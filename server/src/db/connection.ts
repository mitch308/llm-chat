import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DDL, DDL_FTS } from "./schema";
import { seedCategories } from "./seeds";

const instances = new Map<string, Database.Database>();
let fts5Enabled = false;

export const DEFAULT_DB_PATH = path.resolve(
  import.meta.dirname,
  "../../data/llm-chat.db",
);

/** 按路径单例：建目录、建表、种子、FTS（不可用降级）。 */
export function getDb(dbPath?: string): Database.Database {
  const resolved = path.resolve(dbPath ?? DEFAULT_DB_PATH);
  const existing = instances.get(resolved);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(DDL.join(";\n"));
  fts5Enabled = false;
  try {
    db.exec(DDL_FTS);
    fts5Enabled = true;
  } catch {
    // FTS5 未编译：检索降级 LIKE，不阻塞启动
  }
  seedCategories(db);

  instances.set(resolved, db);
  return db;
}

export function getFts5Enabled(): boolean {
  return fts5Enabled;
}

/** 仅测试用：关闭并遗忘全部实例。 */
export function closeAllForTests(): void {
  for (const db of instances.values()) db.close();
  instances.clear();
}
