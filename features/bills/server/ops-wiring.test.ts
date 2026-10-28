import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../../../server/src/db/connection";
import { createFakeLLM } from "../../../server/src/chat/llm";
import { createOpsService } from "../../../server/src/ops/ops.service";
import { createApp } from "../../../server/src/app";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-ops-wiring-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 接线契约：app.ts 把 ASM.ops 传给 opsRoutes——该行接错则所有确认按钮 404
 *  而既有单测（stub handlers 直挂路由）全绿。此测试走生产装配补上这个洞。 */
describe("ASM.ops → opsRoutes 接线（app 级）", () => {
  it("POST /api/actions/bill_create 经生产装配执行写库（元转分）", async () => {
    const app = createApp({ db, llm: createFakeLLM([[]]) });
    const p = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 12.34,
      item: "午饭",
      category: "三餐",
      date: "2026-10-28",
    });

    const res = await request(app)
      .post("/api/actions/bill_create")
      .send({ op_id: p.op_id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    const row = db
      .prepare(`SELECT amount_cents, item FROM bills`)
      .get() as { amount_cents: number; item: string };
    expect(row.amount_cents).toBe(1234); // 12.34 元 → 1234 分
    expect(row.item).toBe("午饭");
  });
});
