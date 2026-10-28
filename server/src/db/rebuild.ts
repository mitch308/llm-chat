import fs from "node:fs";
import path from "node:path";
import { closeDb, DEFAULT_DB_PATH, getDb, getFts5Enabled } from "./connection";

export interface RebuildResult {
  dbPath: string;
  /** 实际删除的文件（主库 + 存在的 WAL/SHM/journal 旁文件）。 */
  removedFiles: string[];
  tableCount: number;
  categoryCount: number;
  fts5Enabled: boolean;
}

/**
 * 删库重建：关闭该路径实例 → 删主库与旁文件 → getDb() 重建 schema + 种子。
 * 若文件被其他进程占用（dev server 未停），抛错提示先停进程（Windows EBUSY）。
 */
export function rebuildDb(dbPath?: string): RebuildResult {
  const resolved = path.resolve(dbPath ?? DEFAULT_DB_PATH);
  closeDb(resolved);

  const candidates = [
    resolved,
    `${resolved}-wal`,
    `${resolved}-shm`,
    `${resolved}-journal`,
  ];
  const removedFiles: string[] = [];
  for (const file of candidates) {
    try {
      fs.rmSync(file);
      removedFiles.push(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EBUSY" || code === "EPERM") {
        throw new Error(
          `无法删除 ${file}（${code}）：文件被其他进程占用，先停掉 dev server 再重建`,
        );
      }
      throw err;
    }
  }

  const db = getDb(resolved);
  const tableCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'news_fts%'",
      )
      .get() as { n: number }
  ).n;
  const categoryCount = (
    db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }
  ).n;

  return {
    dbPath: resolved,
    removedFiles,
    tableCount,
    categoryCount,
    fts5Enabled: getFts5Enabled(),
  };
}
