import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createApp } from "../app";
import { createFakeLLM } from "../chat/llm";
import { createOpsService } from "./ops.service";

let dirs: string[] = [];
let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-actions-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
  // 每个测试独立的 fake LLM（单轮俏皮话脚本，避免轮次跨测试耗尽）
  app = createApp({ db, llm: createFakeLLM([[{ type: "text", delta: "吃的比穿的多🍜" }]]) });
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function countBills(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM bills").get() as { n: number }).n;
}

describe("POST /api/actions/:name", () => {
  it("executes bill_create: yuan→cents, category name→leaf id, quip attached", async () => {
    const p = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 200,
      item: "衣服",
      category: "衣服",
      date: "2026-10-27",
    });

    const res = await request(app).post("/api/actions/bill_create").send({ op_id: p.op_id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.bill.amount_cents).toBe(20000);
    expect(res.body.bill.categoryName).toBe("衣服");
    expect(res.body.bill.parentName).toBe("服饰");
    // quip 后台异步生成，响应不阻塞（回归：5s 超时掐死生成）
    expect(res.body.quip).toBeNull();
    expect(countBills()).toBe(1);

    // 后台生成后补写进 result_json
    await vi.waitFor(async () => {
      const row = createOpsService(db).getOps([p.op_id])[0];
      expect(row.result_json).toContain("吃的比穿的多");
    });
  });

  it("replaying the same op_id returns already and writes nothing new", async () => {
    const svc = createOpsService(db);
    const p = svc.proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 200,
      item: "衣服",
      category: "衣服",
      date: "2026-10-27",
    });

    const first = await request(app).post("/api/actions/bill_create").send({ op_id: p.op_id });
    expect(first.body.status).toBe("executed");
    // 等后台 quip 补写完成，再重放：already 返回存储的 quip
    await vi.waitFor(() => {
      expect(createOpsService(db).getOps([p.op_id])[0].result_json).toContain("吃的比穿的多");
    });

    const second = await request(app).post("/api/actions/bill_create").send({ op_id: p.op_id });

    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already");
    expect(second.body.bill.id).toBe(first.body.bill.id);
    expect(second.body.quip).toBe("吃的比穿的多🍜");
    expect(countBills()).toBe(1);
  });

  it("expired proposal → 409 OP_EXPIRED and no write", async () => {
    const p = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 50,
      item: "地铁",
      category: "公交地铁",
      date: "2026-10-27",
    });
    db.prepare(
      `UPDATE op_proposals SET created_at = datetime('now', '-11 minutes') WHERE op_id = ?`,
    ).run(p.op_id);

    const res = await request(app).post("/api/actions/bill_create").send({ op_id: p.op_id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OP_EXPIRED");
    expect(countBills()).toBe(0);
  });

  it("cancel_op marks the proposal cancelled", async () => {
    const p = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 20,
      item: "咖啡",
      category: "饮料奶茶",
      date: "2026-10-27",
    });
    const res = await request(app).post("/api/actions/cancel_op").send({ op_id: p.op_id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(createOpsService(db).getOps([p.op_id])[0].status).toBe("cancelled");
  });

  it("parent category name resolves to a leaf; unknown name → 400 readable error", async () => {
    const a = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 300,
      item: "羽绒服",
      category: "服饰",
      date: "2026-10-27",
    });
    const resA = await request(app).post("/api/actions/bill_create").send({ op_id: a.op_id });
    expect(resA.status).toBe(200);
    expect(resA.body.bill.categoryName).toBe("衣服");
    expect(resA.body.bill.parentName).toBe("服饰");

    const b = createOpsService(db).proposeOp("bill_create", {
      type: "expense",
      amount_yuan: 10,
      item: "x",
      category: "不存在的类目",
      date: "2026-10-27",
    });
    const resB = await request(app).post("/api/actions/bill_create").send({ op_id: b.op_id });
    expect(resB.status).toBe(400);
    expect(resB.body.message).toContain("不存在的类目");
  });

  it("rejects action name that mismatches the proposal kind (C1 guard)", async () => {
    const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;
    const created = db
      .prepare(
        `INSERT INTO bills (type, amount_cents, item, category_id, date) VALUES ('expense', 6800, '寿司', ?, '2026-10-27')`,
      )
      .run(catId);
    const billId = Number(created.lastInsertRowid);

    // 删除提议，却打 bill_create → 必须拒绝且不得新建
    const del = createOpsService(db).proposeOp("bill_delete", { id: billId });
    const res = await request(app).post("/api/actions/bill_create").send({ op_id: del.op_id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OP_KIND_MISMATCH");
    expect(countBills()).toBe(1); // 原账单仍在，未误建

    // 正确通道仍然工作
    const ok = await request(app).post("/api/actions/bill_delete").send({ op_id: del.op_id });
    expect(ok.status).toBe(200);
    expect(countBills()).toBe(0);
  });

  it("bill_update and bill_delete flow through actions", async () => {
    const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;
    const created = db
      .prepare(
        `INSERT INTO bills (type, amount_cents, item, category_id, date) VALUES ('expense', 6800, '寿司', ?, '2026-10-27')`,
      )
      .run(catId);
    const billId = Number(created.lastInsertRowid);

    const up = createOpsService(db).proposeOp("bill_update", {
      id: billId,
      amount_yuan: 50,
    });
    const upRes = await request(app).post("/api/actions/bill_update").send({ op_id: up.op_id });
    expect(upRes.status).toBe(200);
    expect(upRes.body.bill.amount_cents).toBe(5000);

    const del = createOpsService(db).proposeOp("bill_delete", { id: billId });
    const delRes = await request(app).post("/api/actions/bill_delete").send({ op_id: del.op_id });
    expect(delRes.status).toBe(200);
    expect(countBills()).toBe(0);
  });
});

describe("GET /api/ops", () => {
  it("returns proposals by op_ids", async () => {
    const svc = createOpsService(db);
    const a = svc.proposeOp("bill_create", { item: "a" });
    const res = await request(app).get(`/api/ops?op_ids=${a.op_id}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].op_id).toBe(a.op_id);
  });
});
