import type Database from "better-sqlite3";
import type { LLMClient } from "@llm-chat/features/server";
import type { Bill } from "./bills.service";
import { monthRange } from "./bill-ops";

export interface QuipContext {
  bill: Bill;
  monthCategoryTotalCents: number;
  monthCategoryCount: number;
  monthTotalCents: number;
}

const QUIP_MAX_CHARS = 30;
/** 实测 glm-5.3-flash 首 token 可达 ~13s（2026-10-28），5s 会掐死每次生成；
 *  quip 已改为后台异步补写，不再阻塞任何用户路径，超时放宽到 15s。 */
export const QUIP_TIMEOUT_MS = 15000;

const SYSTEM = `你是记账 App 的吐槽小助手。根据给到的真实统计数据，对用户刚记的这笔账回一句俏皮话。
规则：
- 只输出这一句话本身，不要任何前后缀、引号或解释
- 不超过30个字，可以带一个 emoji
- 语气：同类目金额或频次明显偏高 → 朋友式吐槽；收入/退款类 → 夸奖；金额异常大 → 温和提醒；普通小额 → 简短鼓励
- 只能引用给到的真实数据，禁止编造数字
- 不说教、不冒犯、不连环轰炸`;

function buildUserPrompt(ctx: QuipContext): string {
  const yuan = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");
  const sign = ctx.bill.type === "income" ? "收入" : "支出";
  return [
    `刚记的账：${sign} ¥${yuan(ctx.bill.amount_cents)}（${ctx.bill.item}，类目：${ctx.bill.categoryName}${ctx.bill.parentName ? "/" + ctx.bill.parentName : ""}）`,
    `本月同类目累计：¥${yuan(ctx.monthCategoryTotalCents)}，共 ${ctx.monthCategoryCount} 笔`,
    `本月总支出：¥${yuan(ctx.monthTotalCents)}`,
  ].join("\n");
}

/** 生成俏皮话；超时/异常/空结果一律 null，绝不影响记账主流程。 */
export async function generateQuip(ctx: QuipContext, llm: LLMClient): Promise<string | null> {
  const consume = async (): Promise<string | null> => {
    let text = "";
    for await (const delta of llm.stream({
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
      tools: [],
    })) {
      if (delta.type === "text") text += delta.delta;
    }
    const trimmed = text
      .trim()
      .replace(/^[「"'](.*)[」"']$/s, "$1")
      .trim();
    if (trimmed.length === 0) return null;
    return Array.from(trimmed).slice(0, QUIP_MAX_CHARS).join("");
  };

  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), QUIP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([consume(), timeout]);
  } catch {
    return null;
  }
}

/** 生成俏皮话（真实统计输入；任何失败返回 null）。自原 server/src/ops/ops.executor.ts 逐字迁移。 */
export async function attachQuip(
  db: Database.Database,
  llm: LLMClient | undefined,
  bill: Bill,
): Promise<string | null> {
  try {
    if (!llm) return null;
    const { from, to } = monthRange(bill.date);
    const monthCat = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
         FROM bills WHERE category_id = ? AND date BETWEEN ? AND ?`,
      )
      .get(bill.category_id, from, to) as { total: number; n: number };
    const monthTotal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bills
           WHERE type = 'expense' AND date BETWEEN ? AND ?`,
        )
        .get(from, to) as { total: number }
    ).total;
    return await generateQuip(
      {
        bill,
        monthCategoryTotalCents: monthCat.total,
        monthCategoryCount: monthCat.n,
        monthTotalCents: monthTotal,
      },
      llm,
    );
  } catch {
    return null;
  }
}

/** quip 后台生成完成后补写进已存的 result_json（不动 data 载荷）。 */
function mergeQuipIntoResult(db: Database.Database, opId: string, quip: string): void {
  const row = db
    .prepare(`SELECT result_json FROM op_proposals WHERE op_id = ?`)
    .get(opId) as { result_json: string | null } | undefined;
  if (!row) return;
  let parsed: { data?: unknown; quip?: string | null };
  try {
    parsed = JSON.parse(row.result_json ?? "{}") as { data?: unknown; quip?: string | null };
  } catch {
    return; // 存量结果不可解析：宁缺 quip 也不覆盖
  }
  parsed.quip = quip;
  db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
    JSON.stringify(parsed),
    opId,
  );
}

/** fire-and-forget：确认立即返回，quip 生成后补写（glm 实测首 token ~13s，不能同步等）。 */
export function attachQuipInBackground(
  db: Database.Database,
  llm: LLMClient | undefined,
  opId: string,
  bill: Bill,
): void {
  void (async () => {
    try {
      const quip = await attachQuip(db, llm, bill);
      if (quip) mergeQuipIntoResult(db, opId, quip);
    } catch {
      // 后台失败静默：quip 是锦上添花
    }
  })();
}
