import type { ToolDef } from "../chat/llm";

/** Agent 工具定义（OpenAI function 格式）。执行体在 agent.ts 注册。 */
export const TOOL_DEFS: ToolDef[] = [
  {
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
  {
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
  {
    type: "function",
    function: {
      name: "propose_op",
      description:
        "创建写操作提议（不直接写库）。返回 op_id 用于生成确认卡片。同一时刻只有一个待确认提议，新的会取代旧的",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bill_create", "bill_update", "bill_delete"] },
          payload: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["expense", "income"] },
              amount_yuan: { type: "number", description: "金额（元），必须为正数" },
              item: { type: "string", description: "事项，如 午饭/打车/羽绒服" },
              category: { type: "string", description: "叶子类目名，如 三餐/打车/衣服" },
              date: { type: "string", description: "YYYY-MM-DD" },
              note: { type: "string" },
              id: { type: "number", description: "bill_update/bill_delete 时目标账单 id" },
            },
            required: ["amount_yuan", "item", "category", "date"],
          },
        },
        required: ["kind", "payload"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_op",
      description:
        "执行待确认提议。仅当用户对眼前的确认卡片明确文字确认（如「确认/对/保存吧」）时才可调用",
      parameters: {
        type: "object",
        properties: {
          op_id: { type: "string" },
        },
        required: ["op_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_news",
      description:
        "搜索新闻（按需抓取）。keywords 传入联想扩展后的多个词；mode=hot 为热点榜；source 指定来源；from/to 仅 Hacker News 与 The Guardian 支持历史区间",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "关键词数组（含扩展词），关键词模式必填",
          },
          mode: { type: "string", enum: ["keyword", "hot"] },
          source: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
  },
];
