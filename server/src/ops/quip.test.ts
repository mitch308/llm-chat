import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createBill } from "../bills/bills.service";
import { createFakeLLM, type LLMClient } from "../chat/llm";
import { generateQuip } from "./quip";

let dirs: string[] = [];
let db: Database.Database;
let bill: ReturnType<typeof createBill>;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-quip-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
  const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;
  bill = createBill(db, {
    type: "expense",
    amountCents: 6800,
    item: "寿司放题",
    categoryId: catId,
    date: "2026-10-27",
  });
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const makeCtx = () => ({
  bill,
  monthCategoryTotalCents: 321000,
  monthCategoryCount: 22,
  monthTotalCents: 580000,
});

describe("generateQuip", () => {
  it("returns the quip text from the LLM", async () => {
    const llm = createFakeLLM([[{ type: "text", delta: "吃的比穿的多🍜" }]]);
    await expect(generateQuip(makeCtx(), llm)).resolves.toBe("吃的比穿的多🍜");
  });

  it("returns null when the LLM hangs past 5s", async () => {
    vi.useFakeTimers();
    try {
      const hang: LLMClient = {
        stream: async function* () {
          await new Promise<never>(() => {});
        },
      };
      const p = generateQuip(makeCtx(), hang);
      await vi.advanceTimersByTimeAsync(5100);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-trims over-long quips to 30 chars", async () => {
    const long = "这句话特别特别长".repeat(10) + "！";
    const llm = createFakeLLM([[{ type: "text", delta: long }]]);
    const quip = await generateQuip(makeCtx(), llm);
    expect(quip).not.toBeNull();
    expect([...quip!].length).toBeLessThanOrEqual(30);
  });

  it("returns null when the LLM stream throws", async () => {
    const boom: LLMClient = {
      stream: async function* () {
        throw new Error("api down");
      },
    };
    await expect(generateQuip(makeCtx(), boom)).resolves.toBeNull();
  });

  it("returns null for empty output", async () => {
    const llm = createFakeLLM([[{ type: "text", delta: "   " }]]);
    await expect(generateQuip(makeCtx(), llm)).resolves.toBeNull();
  });
});
