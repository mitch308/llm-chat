import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpHandler } from "@llm-chat/features/server";
import { closeAllForTests, getDb } from "../db/connection";
import { createFakeLLM } from "../chat/llm";
import { createOpsService } from "./ops.service";
import { opsRoutes } from "./ops.routes";

let dirs: string[] = [];
let db: Database.Database;
let app: express.Express;

/** stub 执行体调用计数（幂等重放/守卫拒绝时不得触达业务执行）。 */
let executeCalls = 0;

/** stub handlers：以 stub_create/stub_delete/stub_fail 三个 kind 覆盖生命周期与守卫，
 *  业务断言（账单校验/类目/金额）已迁 features/bills/server/bill-ops.test.ts。 */
function stubHandlers(): ReadonlyMap<string, OpHandler> {
  const ok = (data: object): OpHandler => ({
    argPayload: z.object({}).passthrough(),
    execute: async () => {
      executeCalls += 1;
      return { ok: true, data };
    },
    afterExecute: (env, data) => {
      // 模拟真实 handler：写 result_json（quip 由后台补写，此处直接占位）
      db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
        JSON.stringify({ data, quip: null }),
        env.opId,
      );
    },
  });
  return new Map<string, OpHandler>([
    ["stub_create", ok({ stub: "created" })],
    ["stub_delete", ok({ deleted: true })],
    [
      "stub_fail",
      {
        argPayload: z.object({}).passthrough(),
        execute: async () => {
          executeCalls += 1;
          return { ok: false, code: "STUB_BOMB", message: "stub 业务失败" };
        },
      },
    ],
  ]);
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-actions-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
  executeCalls = 0;
  app = express();
  app.use(express.json());
  app.use("/api", opsRoutes(db, createFakeLLM([[{ type: "text", delta: "quip" }]]), stubHandlers()));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("POST /api/actions/:name", () => {
  it("dispatches via handlers, calls afterExecute, response spreads handler data", async () => {
    const p = createOpsService(db).proposeOp("stub_create", { anything: 1 });

    const res = await request(app).post("/api/actions/stub_create").send({ op_id: p.op_id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.stub).toBe("created");
    expect(res.body.deleted).toBe(false);
    expect(res.body.quip).toBeNull();
    expect(executeCalls).toBe(1);

    // afterExecute 已把结果写进 result_json
    const row = createOpsService(db).getOps([p.op_id])[0];
    expect(JSON.parse(row.result_json!)).toEqual({ data: { stub: "created" }, quip: null });
  });

  it("replaying the same op_id returns already with stored data and quip (readOpResult)", async () => {
    const svc = createOpsService(db);
    const p = svc.proposeOp("stub_create", { anything: 1 });

    const first = await request(app).post("/api/actions/stub_create").send({ op_id: p.op_id });
    expect(first.body.status).toBe("executed");
    // 模拟后台 quip 补写完成
    const stored = JSON.parse(svc.getOps([p.op_id])[0].result_json!) as { data: object; quip: string | null };
    stored.quip = "stub-quip";
    db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
      JSON.stringify(stored),
      p.op_id,
    );

    const second = await request(app).post("/api/actions/stub_create").send({ op_id: p.op_id });

    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already");
    expect(second.body.stub).toBe("created");
    expect(second.body.quip).toBe("stub-quip");
    expect(executeCalls).toBe(1); // run 只执行一次（幂等重放）
  });

  it("expired proposal → 409 OP_EXPIRED and handler not called", async () => {
    const p = createOpsService(db).proposeOp("stub_create", { anything: 1 });
    db.prepare(
      `UPDATE op_proposals SET created_at = datetime('now', '-11 minutes') WHERE op_id = ?`,
    ).run(p.op_id);

    const res = await request(app).post("/api/actions/stub_create").send({ op_id: p.op_id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OP_EXPIRED");
    expect(executeCalls).toBe(0);
  });

  it("cancel_op marks the proposal cancelled", async () => {
    const p = createOpsService(db).proposeOp("stub_create", { anything: 1 });
    const res = await request(app).post("/api/actions/cancel_op").send({ op_id: p.op_id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(createOpsService(db).getOps([p.op_id])[0].status).toBe("cancelled");
  });

  it("unknown action name → 404 NOT_FOUND", async () => {
    const p = createOpsService(db).proposeOp("stub_create", { anything: 1 });
    const res = await request(app).post("/api/actions/bill_create").send({ op_id: p.op_id });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(executeCalls).toBe(0);
  });

  it("unknown op_id → 409 OP_NOT_FOUND", async () => {
    const res = await request(app).post("/api/actions/stub_create").send({ op_id: "nope" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OP_NOT_FOUND");
  });

  it("rejects action name that mismatches the proposal kind (C1 guard)", async () => {
    // stub_delete 提议，却打 stub_create → 必须拒绝且不得执行
    const del = createOpsService(db).proposeOp("stub_delete", { id: 1 });
    const res = await request(app).post("/api/actions/stub_create").send({ op_id: del.op_id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OP_KIND_MISMATCH");
    expect(res.body.message).toContain("stub_delete");
    expect(executeCalls).toBe(0);

    // 正确通道仍然工作
    const ok = await request(app).post("/api/actions/stub_delete").send({ op_id: del.op_id });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(true);
  });

  it("run ok:false → 400 with code/message, proposal stays pending（可重试）", async () => {
    const p = createOpsService(db).proposeOp("stub_fail", { anything: 1 });
    const res = await request(app).post("/api/actions/stub_fail").send({ op_id: p.op_id });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "STUB_BOMB", message: "stub 业务失败" });
    expect(createOpsService(db).getOps([p.op_id])[0].status).toBe("pending");
  });

  it("missing op_id → 400 BAD_REQUEST", async () => {
    const res = await request(app).post("/api/actions/stub_create").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });
});

describe("GET /api/ops", () => {
  it("returns proposals by op_ids", async () => {
    const svc = createOpsService(db);
    const a = svc.proposeOp("stub_create", { item: "a" });
    const res = await request(app).get(`/api/ops?op_ids=${a.op_id}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].op_id).toBe(a.op_id);
  });
});
