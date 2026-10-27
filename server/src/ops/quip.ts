import type { Bill } from "../bills/bills.service";
import type { LLMClient } from "../chat/llm";

export interface QuipContext {
  bill: Bill;
  monthCategoryTotalCents: number;
  monthCategoryCount: number;
  monthTotalCents: number;
}

const QUIP_MAX_CHARS = 30;
const QUIP_TIMEOUT_MS = 5000;

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
