import { z } from "zod";
import type { ToolEntry } from "@llm-chat/features/server";
import { billStats, listBills } from "./bills.service";

/** query_bills 入参 schema（自原 server/src/agent/agent.ts argSchemas 逐字迁移）。 */
const queryBillsArgs = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    category: z.string().optional(),
    type: z.enum(["expense", "income"]).optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

/** bills_stats 入参 schema（自原 agent.ts argSchemas 逐字迁移）。 */
const billsStatsArgs = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    type: z.enum(["expense", "income"]).optional(),
    group_by: z.enum(["category", "date"]),
    level: z.enum(["parent", "leaf"]).optional(),
  })
  .strict();

/** 查询账单明细工具（def 自原 server/src/agent/tools.ts、执行体自 agent.ts case 逐字迁移）。 */
export const queryBillsTool: ToolEntry = {
  def: {
    type: "function",
    function: {
      name: "query_bills",
      description:
        "查询账单明细。时间/类目/类型/关键词可任意组合。category 支持父类名（如 交通=全部子类汇总）或叶子名（如 打车）",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "起始日期 YYYY-MM-DD（含）" },
          to: { type: "string", description: "结束日期 YYYY-MM-DD（含）" },
          category: { type: "string", description: "类目名（父类或叶子）" },
          type: { type: "string", enum: ["expense", "income"] },
          q: { type: "string", description: "事项关键词" },
          limit: { type: "number", description: "默认 20，上限 50" },
        },
      },
    },
  },
  schema: queryBillsArgs,
  async execute(args, env) {
    const q = args as z.infer<typeof queryBillsArgs>;
    const items = listBills(env.db, {
      from: q.from,
      to: q.to,
      category: q.category,
      type: q.type,
      kw: q.q,
      limit: q.limit ?? 20,
    });
    return JSON.stringify({ ok: true, items });
  },
};

/** 账单统计工具（同上逐字迁移）。 */
export const billsStatsTool: ToolEntry = {
  def: {
    type: "function",
    function: {
      name: "bills_stats",
      description:
        "账单统计（总额/分组汇总）。总额类问题必须用本工具，禁止心算。group_by=category 时 level 可选 parent（父类汇总）/leaf（叶子）",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string", enum: ["expense", "income"] },
          group_by: { type: "string", enum: ["category", "date"] },
          level: { type: "string", enum: ["parent", "leaf"] },
        },
        required: ["group_by"],
      },
    },
  },
  schema: billsStatsArgs,
  async execute(args, env) {
    const s = args as z.infer<typeof billsStatsArgs>;
    const items = billStats(env.db, {
      from: s.from,
      to: s.to,
      type: s.type,
      groupBy: s.group_by,
      level: s.level,
    });
    return JSON.stringify({ ok: true, items });
  },
};
