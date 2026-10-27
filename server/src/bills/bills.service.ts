import type Database from "better-sqlite3";

export interface Bill {
  id: number;
  type: "expense" | "income";
  amount_cents: number;
  item: string;
  category_id: number;
  date: string;
  note: string | null;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
  categoryName: string;
  parentName: string | null;
}

export interface CreateBillInput {
  type: "expense" | "income";
  amountCents: number;
  item: string;
  categoryId: number;
  date: string;
  note?: string;
  sourceMessageId?: number;
}

export interface UpdateBillPatch {
  amountCents?: number;
  item?: string;
  categoryId?: number;
  date?: string;
  note?: string | null;
}

export interface ListBillsQuery {
  from?: string;
  to?: string;
  category?: string;
  type?: string;
  kw?: string;
  limit?: number;
  offset?: number;
}

export interface StatsQuery {
  from?: string;
  to?: string;
  type?: string;
  groupBy: "category" | "date";
  level?: "parent" | "leaf";
}

export interface StatsRow {
  key: string;
  totalCents: number;
  count: number;
}

const SELECT_BILL = `
  SELECT b.*, c.name AS categoryName, p.name AS parentName
  FROM bills b
  JOIN categories c ON b.category_id = c.id
  LEFT JOIN categories p ON c.parent_id = p.id`;

function validateAmount(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error("amount_cents 必须为正整数（分）");
  }
}

export function createBill(db: Database, input: CreateBillInput): Bill {
  validateAmount(input.amountCents);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("date 须为 YYYY-MM-DD");
  }
  const row = db
    .prepare(
      `INSERT INTO bills (type, amount_cents, item, category_id, date, note, source_message_id)
       VALUES (@type, @amountCents, @item, @categoryId, @date, @note, @sourceMessageId)`,
    )
    .run({
      type: input.type,
      amountCents: input.amountCents,
      item: input.item,
      categoryId: input.categoryId,
      date: input.date,
      note: input.note ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    });
  return getBill(db, Number(row.lastInsertRowid))!;
}

export function getBill(db: Database, id: number): Bill | undefined {
  return db.prepare(`${SELECT_BILL} WHERE b.id = ?`).get(id) as Bill | undefined;
}

export function updateBill(db: Database, id: number, patch: UpdateBillPatch): Bill {
  const current = getBill(db, id);
  if (!current) throw new Error(`账单 ${id} 不存在`);
  const next = {
    amountCents: patch.amountCents ?? current.amount_cents,
    item: patch.item ?? current.item,
    categoryId: patch.categoryId ?? current.category_id,
    date: patch.date ?? current.date,
    note: patch.note !== undefined ? patch.note : current.note,
  };
  validateAmount(next.amountCents);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date)) {
    throw new Error("date 须为 YYYY-MM-DD");
  }
  db.prepare(
    `UPDATE bills SET amount_cents=@amountCents, item=@item, category_id=@categoryId,
     date=@date, note=@note, updated_at=datetime('now') WHERE id=@id`,
  ).run({ ...next, id });
  return getBill(db, id)!;
}

export function deleteBill(db: Database, id: number): void {
  const row = db.prepare(`DELETE FROM bills WHERE id = ?`).run(id);
  if (row.changes === 0) throw new Error(`账单 ${id} 不存在`);
}

/** 类目名（父或叶）→ 该维度包含的全部类目 id 集合。 */
export function resolveCategoryIds(db: Database, name: string): number[] {
  const cat = db.prepare(`SELECT id FROM categories WHERE name = ?`).get(name) as
    | { id: number }
    | undefined;
  if (!cat) throw new Error(`类目不存在: ${name}`);
  const children = db
    .prepare(`SELECT id FROM categories WHERE parent_id = ?`)
    .all(cat.id) as { id: number }[];
  if (children.length > 0) return [cat.id, ...children.map((c) => c.id)];
  return [cat.id];
}

export function listBills(db: Database, q: ListBillsQuery): Bill[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) {
    where.push("b.date >= @from");
    params.from = q.from;
  }
  if (q.to) {
    where.push("b.date <= @to");
    params.to = q.to;
  }
  if (q.type) {
    where.push("b.type = @type");
    params.type = q.type;
  }
  if (q.category) {
    const ids = resolveCategoryIds(db, q.category);
    where.push(`b.category_id IN (${ids.map((_, i) => `@cat${i}`).join(",")})`);
    ids.forEach((id, i) => (params[`cat${i}`] = id));
  }
  if (q.kw) {
    where.push("b.item LIKE @kw");
    params.kw = `%${q.kw}%`;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.limit = Math.min(q.limit ?? 50, 200);
  params.offset = q.offset ?? 0;
  return db
    .prepare(`${SELECT_BILL} ${clause} ORDER BY b.date DESC, b.id DESC LIMIT @limit OFFSET @offset`)
    .all(params) as Bill[];
}

export function billStats(db: Database, q: StatsQuery): StatsRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) {
    where.push("b.date >= @from");
    params.from = q.from;
  }
  if (q.to) {
    where.push("b.date <= @to");
    params.to = q.to;
  }
  if (q.type) {
    where.push("b.type = @type");
    params.type = q.type;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const keyExpr =
    q.groupBy === "date"
      ? "b.date"
      : q.level === "leaf"
        ? "c.name"
        : "COALESCE(p.name, c.name)";

  return db
    .prepare(
      `SELECT ${keyExpr} AS key, SUM(b.amount_cents) AS totalCents, COUNT(*) AS count
       FROM bills b
       JOIN categories c ON b.category_id = c.id
       LEFT JOIN categories p ON c.parent_id = p.id
       ${clause}
       GROUP BY key
       ORDER BY totalCents DESC`,
    )
    .all(params) as StatsRow[];
}
