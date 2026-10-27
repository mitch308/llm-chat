import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, getFts5Enabled, closeAllForTests } from "./connection";

let dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-db-"));
  dirs.push(dir);
  return path.join(dir, "test.db");
}

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("db layer", () => {
  it("returns the same instance for the same path", () => {
    const p = tempDbPath();
    expect(getDb(p)).toBe(getDb(p));
  });

  it("creates all 6 tables", () => {
    const db = getDb(tempDbPath());
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of [
      "messages",
      "bills",
      "categories",
      "news_items",
      "news_fetch_runs",
      "op_proposals",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("seeds 11 expense parent categories and 4 top-level income categories", () => {
    const db = getDb(tempDbPath());
    const parents = db
      .prepare(
        "SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NULL AND kind='expense'",
      )
      .get() as { n: number };
    expect(parents.n).toBe(11);
    const income = db
      .prepare(
        "SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NULL AND kind='income'",
      )
      .get() as { n: number };
    expect(income.n).toBe(4);
  });

  it("交通 has exactly 5 seeded leaves", () => {
    const db = getDb(tempDbPath());
    const leaves = db
      .prepare(
        `SELECT c.name FROM categories c
         JOIN categories p ON c.parent_id = p.id
         WHERE p.name = '交通' ORDER BY c.name`,
      )
      .all() as { name: string }[];
    expect(leaves.map((l) => l.name)).toEqual([
      "停车",
      "公交地铁",
      "加油",
      "打车",
      "火车机票",
    ]);
  });

  it("reports fts5 availability and creates news_fts when enabled", () => {
    getDb(tempDbPath());
    expect(typeof getFts5Enabled()).toBe("boolean");
    if (getFts5Enabled()) {
      const db = getDb(tempDbPath());
      const fts = db
        .prepare("SELECT name FROM sqlite_master WHERE name='news_fts'")
        .get();
      expect(fts).toBeTruthy();
    }
  });
});
