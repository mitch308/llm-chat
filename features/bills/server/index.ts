import { z } from "zod";
import { defineServerFeature } from "@llm-chat/features/server";
import { seedCategories } from "./seeds";
import {
  BILL_ACTIONS,
  BILL_COMPONENTS,
  BillConfirmCardProps,
  BillItemProps,
  BillListProps,
} from "../shared";

/**
 * 记账技能 body：原 server/src/agent/prompts.ts 的「# 记账技能——记录/查询统计/修改删除」
 * 三段逐字迁移；最前两条为原「通用规则」中的记账专属 bullet（金额表达/两级类目）原文。
 */
const BILL_SKILL_BODY = `- 金额支持 元/块/万元 表达，amount_yuan 用数字（元）
- 类目为两级：记账时选**叶子类目名**。示例："加油300"→"加油"；"花点钱吃饭"→"三餐"。查询时支持两级：说"交通"=父类汇总（加油+打车+停车+公交地铁+火车机票），说"打车"=子类单独查询。用户说法不匹配任何类目时用关键词(q)检索事项

# 记账技能——记录

1. 提取：type(expense/income)、amount_yuan、item、category(叶子名)、date、note
2. 金额缺失或含糊 → 纯文字追问具体金额
3. 调 propose_op(kind="bill_create", payload={type, amount_yuan, item, category, date, note})；提议创建后用返回的 op_id 生成 BillConfirmCard（status="pending"），只在这一轮附一句简短说明（此前工具回合已说过的话不要重复）
4. 疑似重复（工具返回或上下文提示同金额同类目同日已存在）→ 卡片 warning 字段提醒"今天已有一笔类似记录"
5. 用户文字回复"确认/对/保存吧" → 调 execute_op(op_id)，然后按执行结果出 saved 卡片或说明
6. 用户要修改/取消 → 引导点卡片按钮或直接说明

# 记账技能——查询/统计

1. 解析维度：时间范围、类目（两级）、类型、关键词、粒度
2. 总额类问题必须调 bills_stats，禁止心算列表求和
3. 空结果 → 文字说明"还没有记录"，可附 EmptyState
4. 明细 → BillList；总额 → Metric；类目占比 → StatChart(bar)；按日趋势 → StatChart(line)
5. "什么时候买的X" → BillList 按时间倒序，突出日期

# 记账技能——修改/删除

1. 调 query_bills 定位目标；0 笔 → 文字说明；多笔 → BillList 请用户指认
2. 单笔 → 调 propose_op(kind="bill_update"/"bill_delete")，BillConfirmCard 必须带 kind="bill_update"/"bill_delete"（与提议一致），diff 展示 变更前→变更后（删除则展示将删除的记录）
3. 确认与幂等同记录流程；确认按钮会按提议的 kind 执行，kind 不一致会被服务端拒绝`;

/** bills feature：数据层（DDL/种子）+ 组件/动作目录 + 记账技能提示词。 */
export default defineServerFeature("bills", (ctx) => {
  ctx.ddl([
    `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id),
    kind TEXT NOT NULL CHECK (kind IN ('expense','income'))
  )`,

    `CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('expense','income')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    item TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    date TEXT NOT NULL CHECK (length(date) = 10),
    note TEXT,
    source_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    `CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(date)`,
    `CREATE INDEX IF NOT EXISTS idx_bills_category ON bills(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bills_type ON bills(type)`,
  ]);
  ctx.seed(seedCategories);

  // 组件/动作 zod 自原 server/src/agent/catalog.ts 逐字迁移（经 shared.ts 单一来源）
  ctx.catalogComponents({
    [BILL_COMPONENTS[0]]: {
      props: BillConfirmCardProps,
      description:
        "记账确认卡片。pending 态显示数据与「确认」「取消」按钮；saved 态只读并显示 quip 俏皮话；cancelled/expired 只读",
    },
    [BILL_COMPONENTS[1]]: {
      props: BillListProps,
      description: "账单列表，用于明细查询结果；total_yuan 为可选合计",
    },
    [BILL_COMPONENTS[2]]: {
      props: BillItemProps,
      description: "单条账单行",
    },
  });
  ctx.catalogActions({
    [BILL_ACTIONS[0]]: {
      params: z.object({ op_id: z.string() }),
      description: "确认保存新账单",
    },
    [BILL_ACTIONS[1]]: {
      params: z.object({ op_id: z.string() }),
      description: "确认修改账单",
    },
    [BILL_ACTIONS[2]]: {
      params: z.object({ op_id: z.string() }),
      description: "确认删除账单",
    },
  });
  ctx.skill({
    intent: "记账意图（记录/查询/修改/删除账单）",
    label: "记账技能",
    hint: "📝记账（记录/查询/修改/删除）",
    body: BILL_SKILL_BODY,
  });
});
