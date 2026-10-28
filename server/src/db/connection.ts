import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { isFts5Enabled, setFts5Enabled } from "@llm-chat/features/server";
import { ASM } from "../features";
import { DDL, DDL_FTS } from "./schema";
import { seedCategories } from "./seeds";

const instances = new Map<string, Database.Database>();

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

  db.exec([...DDL, ...ASM.ddl].join(";\n"));

  // ASM 可选 DDL：逐条尝试，首个失败即停并降级（当前空装配为 no-op）
  let optionalOk = true;
  for (const stmt of ASM.ddlOptional) {
    try {
      db.exec(stmt);
    } catch {
      optionalOk = false;
      break;
    }
  }
  setFts5Enabled(optionalOk);
  try {
    db.exec(DDL_FTS);
    if (optionalOk) setFts5Enabled(true);
  } catch {
    // FTS5 未编译：检索降级 LIKE，不阻塞启动
    setFts5Enabled(false);
  }
  seedCategories(db);
  for (const run of ASM.seedFns) run(db);

  instances.set(resolved, db);
  return db;
}

export function getFts5Enabled(): boolean {
  // 旗标已迁至 kernel（features/kernel/server.ts），此处转发以兼容既有导入方
  return isFts5Enabled();
}

/** 关闭并遗忘指定路径的实例；未打开则无操作。 */
export function closeDb(dbPath?: string): void {
  const resolved = path.resolve(dbPath ?? DEFAULT_DB_PATH);
  const db = instances.get(resolved);
  if (db) {
    db.close();
    instances.delete(resolved);
  }
}

/** 仅测试用：关闭并遗忘全部实例。 */
export function closeAllForTests(): void {
  for (const db of instances.values()) db.close();
  instances.clear();
}
