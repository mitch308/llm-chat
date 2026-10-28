import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "./connection";
import { rebuildDb } from "./rebuild";

let dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-rebuild-"));
  dirs.push(dir);
  return path.join(dir, "test.db");
}

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("rebuildDb", () => {
  it("wipes user data and reseeds categories on an existing db", () => {
    const p = tempDbPath();
    const db = getDb(p);
    db.prepare(
      "INSERT INTO messages (role, content_text) VALUES ('user', '旧消息')",
    ).run();
    // 模拟崩溃残留的旁文件（干净关闭时 SQLite 会自己清掉 WAL，残留才会留到重建）
    writeFileSync(`${p}-wal`, "stale");

    const result = rebuildDb(p);

    // 删掉了主库与残留旁文件
    expect(result.removedFiles).toContain(p);
    expect(result.removedFiles).toContain(`${p}-wal`);

    const reopened = getDb(p);
    const messages = reopened
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .get() as { n: number };
    expect(messages.n).toBe(0);
    expect(result.categoryCount).toBe(45);
    expect(result.tableCount).toBe(6);
  });

  it("creates a fresh db when no file exists", () => {
    const p = tempDbPath();

    const result = rebuildDb(p);

    expect(result.removedFiles).toEqual([]);
    expect(result.categoryCount).toBe(45);
    expect(getDb(p).prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
  });
});
