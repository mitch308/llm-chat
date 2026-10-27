import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createApp } from "../app";
import {
  billStats,
  createBill,
  deleteBill,
  listBills,
  updateBill,
} from "./bills.service";
import type Database from "better-sqlite3";

let dirs: string[] = [];
let db: Database.Database;

function seedBill(type: "expense" | "income", cents: number, item: string, categoryName: string, date = "2026-10-15") {
  const cat = db
    .prepare("SELECT id FROM categories WHERE name = ?")
    .get(categoryName) as { id: number };
  return createBill(db, {
    type,
    amountCents: cents,
    item,
    categoryId: cat.id,
    date,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-bills-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("bills service", () => {
  beforeEach(() => {
    seedBill("expense", 3000, "滴滴回家", "打车");
    seedBill("expense", 30000, "92号汽油", "加油");
    seedBill("expense", 1000, "商场停车", "停车");
    seedBill("expense", 20000, "羽绒服", "衣服");
    seedBill("income", 5000, "网购退款", "退款");
  });

  it("rejects non-positive amount_cents", () => {
    expect(() => seedBill("expense", 0, "x", "三餐")).toThrow();
    expect(() => seedBill("expense", -100, "x", "三餐")).toThrow();
  });

  it("expands parent category 交通 to all leaves in listBills", () => {
    const rows = listBills(db, { category: "交通" });
    expect(rows).toHaveLength(3);
    const items = rows.map((r) => r.item).sort();
    expect(items).toEqual(["92号汽油", "商场停车", "滴滴回家"]);
    // Bill join 出父子类目名
    const didi = rows.find((r) => r.item === "滴滴回家")!;
    expect(didi.categoryName).toBe("打车");
    expect(didi.parentName).toBe("交通");
  });

  it("aggregates stats by parent category and by leaf", () => {
    const byParent = billStats(db, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "category",
      level: "parent",
    });
    const traffic = byParent.find((r) => r.key === "交通")!;
    expect(traffic.totalCents).toBe(34000);
    expect(traffic.count).toBe(3);

    const byLeaf = billStats(db, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "category",
      level: "leaf",
    });
    const taxi = byLeaf.find((r) => r.key === "打车")!;
    expect(taxi.totalCents).toBe(3000);
    expect(taxi.count).toBe(1);
  });

  it("filters by item keyword", () => {
    const rows = listBills(db, { kw: "羽绒服" });
    expect(rows).toHaveLength(1);
    expect(rows[0].item).toBe("羽绒服");
  });

  it("date range boundaries are inclusive", () => {
    seedBill("expense", 500, "地铁", "公交地铁", "2026-10-01");
    seedBill("expense", 600, "公交", "公交地铁", "2026-10-31");
    const rows = listBills(db, { from: "2026-10-01", to: "2026-10-31" });
    expect(rows).toHaveLength(7);
  });

  it("updates and deletes bills", () => {
    const target = listBills(db, { kw: "羽绒服" })[0];
    const updated = updateBill(db, target.id, { amountCents: 15000 });
    expect(updated.amount_cents).toBe(15000);
    expect(updated.updated_at >= target.updated_at).toBe(true);

    deleteBill(db, target.id);
    expect(listBills(db, { kw: "羽绒服" })).toHaveLength(0);
  });

  it("stats groupBy date returns per-day rows", () => {
    seedBill("expense", 500, "地铁", "公交地铁", "2026-10-16");
    const byDate = billStats(db, {
      from: "2026-10-15",
      to: "2026-10-16",
      groupBy: "date",
    });
    const d15 = byDate.find((r) => r.key === "2026-10-15")!;
    const d16 = byDate.find((r) => r.key === "2026-10-16")!;
    expect(d15.totalCents).toBe(59000);
    expect(d16.totalCents).toBe(500);
  });
});

describe("bills routes", () => {
  it("GET /api/bills filters by category and type", async () => {
    seedBill("expense", 3000, "滴滴回家", "打车");
    seedBill("income", 5000, "网购退款", "退款");

    const app = createApp({ db });
    const res = await request(app).get("/api/bills?category=交通");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].item).toBe("滴滴回家");

    const income = await request(app).get("/api/bills?type=income");
    expect(income.body.items).toHaveLength(1);
    expect(income.body.items[0].type).toBe("income");
  });

  it("GET /api/bills/stats returns grouped totals", async () => {
    seedBill("expense", 3000, "滴滴回家", "打车", "2026-10-20");
    const app = createApp({ db });
    const res = await request(app).get(
      "/api/bills/stats?from=2026-10-01&to=2026-10-31&groupBy=category&level=parent",
    );
    expect(res.status).toBe(200);
    const traffic = res.body.items.find((r: { key: string }) => r.key === "交通");
    expect(traffic.totalCents).toBe(3000);
  });

  it("POST /api/bills validates and creates; PATCH/DELETE roundtrip", async () => {
    const app = createApp({ db });
    const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;

    const bad = await request(app).post("/api/bills").send({
      type: "expense",
      amountCents: 0,
      item: "x",
      categoryId: catId,
      date: "2026-10-20",
    });
    expect(bad.status).toBe(400);

    const created = await request(app).post("/api/bills").send({
      type: "expense",
      amountCents: 1500,
      item: "午饭",
      categoryId: catId,
      date: "2026-10-20",
    });
    expect(created.status).toBe(201);
    expect(created.body.item).toBe("午饭");

    const patched = await request(app)
      .patch(`/api/bills/${created.body.id}`)
      .send({ amountCents: 2000 });
    expect(patched.status).toBe(200);
    expect(patched.body.amount_cents).toBe(2000);

    const deleted = await request(app).delete(`/api/bills/${created.body.id}`);
    expect(deleted.status).toBe(200);
    expect(listBills(db, { kw: "午饭" })).toHaveLength(0);
  });
});
