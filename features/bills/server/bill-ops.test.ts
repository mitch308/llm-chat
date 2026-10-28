import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllForTests, getDb } from "../../../server/src/db/connection";
import { createFakeLLM } from "../../../server/src/chat/llm";
import { createOpsService } from "../../../server/src/ops/ops.service";
import type { OpHandler } from "@llm-chat/features/server";
import { createBill, type Bill } from "./bills.service";
import {
  billOpHandler,
  monthRange,
  runBillAction,
  yuanToCents,
} from "./bill-ops";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-bill-ops-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function seedBill(cents = 6800, item = "寿司"): number {
  const catId = (db.prepare("SELECT id FROM categories WHERE name='三餐'").get() as { id: number }).id;
  return Number(
    db
      .prepare(
        `INSERT INTO bills (type, amount_cents, item, category_id, date) VALUES ('expense', ?, ?, ?, '2026-10-27')`,
      )
      .run(cents, item, catId).lastInsertRowid,
  );
}

function countBills(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM bills").get() as { n: number }).n;
}

const createPayload = {
  type: "expense",
  amount_yuan: 200,
  item: "衣服",
  category: "衣服",
  date: "2026-10-27",
};

describe("runBillAction bill_create", () => {
  it("yuan→cents、类目名→叶子 id，返回 {ok:true, data:{bill}}", () => {
    const r = runBillAction(db, "bill_create", createPayload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { bill: Bill }).bill.amount_cents).toBe(20000);
    expect((r.data as { bill: Bill }).bill.categoryName).toBe("衣服");
    expect((r.data as { bill: Bill }).bill.parentName).toBe("服饰");
    expect(countBills()).toBe(1);
  });

  it("父类名解析到 item 中出现的叶子（服饰+羽绒服→衣服）", () => {
    const r = runBillAction(db, "bill_create", {
      ...createPayload,
      item: "羽绒服",
      category: "服饰",
    });
    expect(r.ok).toBe(true);
    const bill = (r as { data: { bill: Bill } }).data.bill;
    expect(bill.categoryName).toBe("衣服");
    expect(bill.parentName).toBe("服饰");
  });

  it("未知类目 → 抛 OpRunError BAD_CATEGORY（路由层映射 400 可读错误）", () => {
    expect(() =>
      runBillAction(db, "bill_create", { ...createPayload, category: "不存在的类目" }),
    ).toThrow(/类目不存在: 不存在的类目/);
    expect(countBills()).toBe(0);
  });

  it.each([
    [{ ...createPayload, amount_yuan: 0 }, "金额不合法"],
    [{ ...createPayload, amount_yuan: -5 }, "金额不合法"],
    [{ ...createPayload, item: "  " }, "事项不能为空"],
    [{ ...createPayload, date: "2026/10/27" }, "日期须为 YYYY-MM-DD"],
    [{ ...createPayload, category: 1 }, "缺少类目"],
  ])("入参不合法 → ok:false VALIDATION（%s）", (payload, message) => {
    const r = runBillAction(db, "bill_create", payload as Record<string, unknown>);
    expect(r).toMatchObject({ ok: false, code: "VALIDATION", message });
    expect(countBills()).toBe(0);
  });
});

describe("runBillAction bill_update", () => {
  it("amount_yuan 补丁按 cents 写库", () => {
    const id = seedBill();
    const r = runBillAction(db, "bill_update", { id, amount_yuan: 50 });
    expect(r.ok).toBe(true);
    expect((r as { data: { bill: Bill } }).data.bill.amount_cents).toBe(5000);
  });

  it("缺少账单 id → ok:false VALIDATION", () => {
    const r = runBillAction(db, "bill_update", { amount_yuan: 50 });
    expect(r).toMatchObject({ ok: false, code: "VALIDATION", message: "缺少账单 id" });
  });
});

describe("runBillAction bill_delete", () => {
  it("删除既有账单 → {bill, deleted:true}", () => {
    const id = seedBill();
    const r = runBillAction(db, "bill_delete", { id });
    expect(r).toMatchObject({ ok: true, data: { deleted: true } });
    expect(countBills()).toBe(0);
  });

  it("账单不存在 → ok:false NOT_FOUND", () => {
    const r = runBillAction(db, "bill_delete", { id: 999 });
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND", message: "账单 999 不存在" });
  });
});

describe("纯函数", () => {
  it("yuanToCents 四舍五入到分", () => {
    expect(yuanToCents(200)).toBe(20000);
    expect(yuanToCents(3.5)).toBe(350);
  });

  it("monthRange 按账单月份给起止日期", () => {
    expect(monthRange("2026-10-27")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2028-02-05")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("billOpHandler（OpHandler 装配）", () => {
  it("execute(payload, env) 按 kind 闭包分发到 runBillAction", async () => {
    const handler = billOpHandler("bill_create");
    const r = await handler.execute(createPayload, { db });
    expect(r.ok).toBe(true);
    expect((r as { data: { bill: Bill } }).data.bill.amount_cents).toBe(20000);
  });

  it("argPayload 校验 propose_op 的 payload（原 agent argSchemas 逐字迁移）", () => {
    const handler = billOpHandler("bill_create");
    expect(handler.argPayload.safeParse(createPayload).success).toBe(true);
    expect(handler.argPayload.safeParse({ ...createPayload, amount_yuan: -1 }).success).toBe(false);
    expect(handler.argPayload.safeParse({ ...createPayload, date: "x" }).success).toBe(false);
  });

  it("cardHint 两条文案都指向 BillConfirmCard", () => {
    const handler = billOpHandler("bill_create");
    expect(handler.cardHint?.created).toContain("提议已创建");
    expect(handler.cardHint?.created).toContain("BillConfirmCard");
    expect(handler.cardHint?.duplicate).toContain("该提议已存在");
    expect(handler.cardHint?.duplicate).toContain("BillConfirmCard");
  });

  it("afterExecute：writeOpResult 落 result_json + quip 后台补写（回归：5s 超时掐死生成）", async () => {
    const handler: OpHandler = billOpHandler("bill_create");
    const ops = createOpsService(db);
    const p = ops.proposeOp("bill_create", createPayload);
    const bill = createBill(db, {
      type: "expense",
      amountCents: 20000,
      item: "衣服",
      categoryId: (db.prepare("SELECT id FROM categories WHERE name='衣服'").get() as { id: number }).id,
      date: "2026-10-27",
    });

    handler.afterExecute?.({ db, llm: createFakeLLM([[{ type: "text", delta: "吃的比穿的多🍜" }]]), opId: p.op_id }, { bill });

    // 立即落 {data, quip:null}，不阻塞
    await vi.waitFor(() => {
      const row = ops.getOps([p.op_id])[0];
      expect(JSON.parse(row.result_json!).data.bill.item).toBe("衣服");
      expect(JSON.parse(row.result_json!).quip).toBe("吃的比穿的多🍜");
    });
  });
});

describe("cardSpec：服务端直出确认卡片（agent 循环消费）", () => {
  const cardInput = (
    kind: "bill_create" | "bill_update" | "bill_delete",
    payload: Record<string, unknown>,
    over: Partial<{ status: "pending" | "executed"; data: unknown }> = {},
  ) => ({
    opId: "op_x",
    kind,
    status: over.status ?? ("pending" as const),
    payload,
    data: (over.data ?? null) as Record<string, unknown> | null,
  });

  it("bill_create pending：data 从 payload 还原；疑似重复（同金额+同类目+同日期）→ warning", () => {
    const handler = billOpHandler("bill_create");
    const card = handler.cardSpec!(cardInput("bill_create", createPayload), { db });
    expect(card).toEqual({
      type: "BillConfirmCard",
      props: {
        op_id: "op_x",
        kind: "bill_create",
        status: "pending",
        data: { type: "expense", amount_yuan: 200, item: "衣服", category: "衣服", date: "2026-10-27", note: null },
        diff: null,
        quip: null,
        warning: null,
      },
    });

    // 同金额+同类目+同日期已存在 → spec 8.4 第 4 步的黄色提醒
    const catId = (db.prepare("SELECT id FROM categories WHERE name='衣服'").get() as { id: number }).id;
    db.prepare(`INSERT INTO bills (type, amount_cents, item, category_id, date) VALUES ('expense', 20000, '外套', ?, '2026-10-27')`).run(catId);
    const card2 = handler.cardSpec!(cardInput("bill_create", createPayload), { db });
    expect(card2!.props.warning).toBe("今天已有一笔类似记录");
  });

  it("bill_update pending：data 为提议后新状态，diff 展示 变更前→变更后", () => {
    const id = seedBill(6800, "寿司");
    const handler = billOpHandler("bill_update");
    const card = handler.cardSpec!(
      cardInput("bill_update", { id, amount_yuan: 150, item: "寿司", category: "三餐", date: "2026-10-27" }),
      { db },
    );
    expect(card!.props.kind).toBe("bill_update");
    expect(card!.props.data).toMatchObject({ amount_yuan: 150 });
    expect(card!.props.diff).toEqual({
      before: { type: "expense", amount_yuan: 68, item: "寿司", category: "三餐", date: "2026-10-27", note: null },
      after: { type: "expense", amount_yuan: 150, item: "寿司", category: "三餐", date: "2026-10-27", note: null },
    });
  });

  it("bill_delete pending：卡片展示将删除的记录（diff.after=null）", () => {
    const id = seedBill();
    const handler = billOpHandler("bill_delete");
    const card = handler.cardSpec!(cardInput("bill_delete", { id }), { db });
    expect(card!.props.data).toMatchObject({ item: "寿司", amount_yuan: 68 });
    expect(card!.props.diff).toEqual({
      before: { type: "expense", amount_yuan: 68, item: "寿司", category: "三餐", date: "2026-10-27", note: null },
      after: null,
    });
  });

  it("executed：从落库 bill 还原 saved 卡片；quip 留空，由卡片对账补齐", () => {
    const handler = billOpHandler("bill_create");
    const bill = createBill(db, {
      type: "expense",
      amountCents: 20000,
      item: "衣服",
      categoryId: (db.prepare("SELECT id FROM categories WHERE name='衣服'").get() as { id: number }).id,
      date: "2026-10-27",
    });
    const card = handler.cardSpec!(
      cardInput("bill_create", {}, { status: "executed", data: { bill } }),
      { db },
    );
    expect(card!.props.status).toBe("saved");
    expect(card!.props.data).toMatchObject({ amount_yuan: 200, item: "衣服", category: "衣服" });
    expect(card!.props.quip).toBeNull();
    expect(card!.props.diff).toBeNull();
  });
});
