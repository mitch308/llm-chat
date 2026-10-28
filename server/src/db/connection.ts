import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { isFts5Enabled, setFts5Enabled } from "@llm-chat/features/server";
import { ASM } from "../features";
import { DDL } from "./schema";

const instances = new Map<string, Database.Database>();

export const DEFAULT_DB_PATH = path.resolve(
  import.meta.dirname,
  "../../data/llm-chat.db",
);

/** 按路径单例：建目录；建表（核心 DDL + 各 feature 经 ASM.ddl 贡献的表）；种子（ASM.seedFns）；
 *  可选 DDL（ASM.ddlOptional，如 news 的 FTS5 虚表）逐条尝试，失败即降级 LIKE。 */
export function getDb(dbPath?: string): Database.Database {
  const resolved = path.resolve(dbPath ?? DEFAULT_DB_PATH);
  const existing = instances.get(resolved);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec([...DDL, ...ASM.ddl].join(";\n"));

  // ASM 可选 DDL（news feature 的 FTS5 虚表）：逐条尝试，首个失败即停并降级 LIKE
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
  // 种子经 ASM.seedFns 注入（bills feature 注册 seedCategories）
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
