import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createOpsService } from "./ops.service";

let dirs: string[] = [];
let db: Database.Database;
let clock: number;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-ops-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
  clock = new Date("2026-10-27T10:00:00Z").getTime();
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function svc() {
  return createOpsService(db, { now: () => new Date(clock) });
}

describe("op proposal lifecycle", () => {
  it("happy path: propose → execute → executed with result_json", async () => {
    const s = svc();
    const p = s.proposeOp("bill_create", { amount_yuan: 200, item: "衣服" });
    expect(p.status).toBe("pending");
    expect(p.op_id).toBeTruthy();

    let received: unknown;
    const outcome = await s.executeOp(p.op_id, async (payload) => {
      received = payload;
      return { ok: true, data: { id: 1 } };
    });
    expect(outcome).toEqual({ status: "executed", data: { id: 1 } });
    expect(received).toEqual({ amount_yuan: 200, item: "衣服" });

    const row = s.getOps([p.op_id])[0];
    expect(row.status).toBe("executed");
    expect(row.result_json).toContain('"id":1');
    expect(row.executed_at).toBeTruthy();
  });

  it("second execute on same op_id returns already with first data, run called once", async () => {
    const s = svc();
    const p = s.proposeOp("bill_create", { amount_yuan: 1 });
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { ok: true as const, data: { id: 42 } };
    };
    expect(await s.executeOp(p.op_id, run)).toEqual({ status: "executed", data: { id: 42 } });
    expect(await s.executeOp(p.op_id, run)).toEqual({ status: "already", data: { id: 42 } });
    expect(calls).toBe(1);
  });

  it("expires after TTL 10 minutes; run not called", async () => {
    const s = svc();
    const p = s.proposeOp("bill_create", { amount_yuan: 1 });
    clock += 11 * 60 * 1000;
    let calls = 0;
    const outcome = await s.executeOp(p.op_id, async () => {
      calls += 1;
      return { ok: true, data: {} };
    });
    expect(outcome).toEqual({
      status: "invalid",
      reason: "expired",
      message: "提议已过期，请重新发起",
    });
    expect(calls).toBe(0);
    expect(s.getOps([p.op_id])[0].status).toBe("expired");
  });

  it("TTL-dead pending is reported as expired by getOps (read paths enforce TTL too)", () => {
    const s = svc();
    const p = s.proposeOp("bill_create", { item: "早饭" });
    clock += 11 * 60 * 1000;
    expect(s.getOps([p.op_id])[0].status).toBe("expired");
  });

  it("getRecentOpsSummary reports TTL-dead pending as expired (read paths enforce TTL too)", () => {
    const s = svc();
    s.proposeOp("bill_create", { item: "早饭" });
    clock += 11 * 60 * 1000;
    expect(s.getRecentOpsSummary()[0].status).toBe("expired");
  });

  it("new proposal supersedes the pending one as CANCELLED (用户切换账单=放弃确认)", async () => {
    const s = svc();
    const a = s.proposeOp("bill_create", { item: "a" });
    const b = s.proposeOp("bill_create", { item: "b" });
    expect(s.getOps([a.op_id])[0].status).toBe("cancelled");
    expect(s.getOps([b.op_id])[0].status).toBe("pending");

    const outcome = await s.executeOp(b.op_id, async () => ({ ok: true, data: {} }));
    expect(outcome.status).toBe("executed");
  });

  it("cancelled proposal rejects execution", async () => {
    const s = svc();
    const p = s.proposeOp("bill_delete", {});
    s.cancelOp(p.op_id);
    const outcome = await s.executeOp(p.op_id, async () => ({ ok: true, data: {} }));
    expect(outcome).toEqual({
      status: "invalid",
      reason: "cancelled",
      message: "提议已取消",
    });
  });

  it("run throwing keeps status pending and allows retry", async () => {
    const s = svc();
    const p = s.proposeOp("bill_create", { amount_yuan: 9 });
    const boom = async (): Promise<{ ok: true; data: object }> => {
      throw new Error("db down");
    };
    await expect(s.executeOp(p.op_id, boom)).rejects.toThrow("db down");
    expect(s.getOps([p.op_id])[0].status).toBe("pending");

    const outcome = await s.executeOp(p.op_id, async () => ({ ok: true, data: { id: 7 } }));
    expect(outcome.status).toBe("executed");
  });

  it("unknown op_id is invalid/not_found", async () => {
    const s = svc();
    const outcome = await s.executeOp("nope", async () => ({ ok: true, data: {} }));
    expect(outcome).toEqual({
      status: "invalid",
      reason: "not_found",
      message: "提议不存在",
    });
  });

  it("getRecentOpsSummary lists newest-first with payload and final states", async () => {
    const s = svc();
    const first = s.proposeOp("bill_create", {
      amount_yuan: 3,
      item: "早饭",
      date: "2026-10-28",
    });
    await s.executeOp(first.op_id, async () => ({ ok: true, data: {} })); // 按钮确认的等价路径
    const second = s.proposeOp("bill_create", { item: "被取消" });
    s.cancelOp(second.op_id);
    s.proposeOp("bill_create", { amount_yuan: 400, item: "停车费" }); // 新 pending

    const list = s.getRecentOpsSummary(5);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ kind: "bill_create", status: "pending" });
    expect(list[0].payload).toMatchObject({ amount_yuan: 400, item: "停车费" });
    expect(list[1].status).toBe("cancelled");
    expect(list[2].status).toBe("executed");
    expect(list[2].payload).toMatchObject({ amount_yuan: 3, item: "早饭", date: "2026-10-28" });
  });

  it("getRecentOpsSummary respects limit, newest kept", () => {
    const s = svc();
    for (let i = 0; i < 8; i++) s.proposeOp("bill_create", { item: `i${i}` });
    const list = s.getRecentOpsSummary(5);
    expect(list).toHaveLength(5);
    expect(list[0].payload.item).toBe("i7");
  });
});
