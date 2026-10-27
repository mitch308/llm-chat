import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/vue";
import { z } from "zod";

/** 组件目录（与 web/src/render/registry.ts 的组件一一对应，字段见 spec 9.3）。 */
export function buildCatalog() {
  return defineCatalog(schema, {
    components: {
      BillConfirmCard: {
        props: z.object({
          op_id: z.string(),
          status: z.enum(["pending", "saved", "cancelled", "error"]),
          data: z.object({
            type: z.enum(["expense", "income"]),
            amount_yuan: z.number(),
            item: z.string(),
            category: z.string(),
            date: z.string(),
            note: z.string().nullable(),
          }),
          diff: z
            .object({
              before: z.record(z.string(), z.unknown()).nullable(),
              after: z.record(z.string(), z.unknown()).nullable(),
            })
            .nullable(),
          quip: z.string().nullable(),
          warning: z.string().nullable(),
        }),
        description:
          "记账确认卡片。pending 态显示数据与「确认」「取消」按钮；saved 态只读并显示 quip 俏皮话；cancelled/expired 只读",
      },
      BillList: {
        props: z.object({
          title: z.string().nullable(),
          bills: z.array(
            z.object({
              id: z.number(),
              item: z.string(),
              categoryName: z.string(),
              parentName: z.string().nullable(),
              amount_yuan: z.number(),
              type: z.enum(["expense", "income"]),
              date: z.string(),
            }),
          ),
          total_yuan: z.number().nullable(),
        }),
        description: "账单列表，用于明细查询结果；total_yuan 为可选合计",
      },
      BillItem: {
        props: z.object({
          item: z.string(),
          categoryName: z.string(),
          amount_yuan: z.number(),
          type: z.enum(["expense", "income"]),
          date: z.string(),
        }),
        description: "单条账单行",
      },
      Metric: {
        props: z.object({
          label: z.string(),
          value: z.string(),
          format: z.enum(["currency", "number", "percent"]).nullable(),
        }),
        description: "单个指标数值展示（如本月总支出 ¥2,340）",
      },
      StatChart: {
        props: z.object({
          chart: z.enum(["bar", "line"]),
          title: z.string().nullable(),
          series: z.array(z.object({ name: z.string(), value: z.number() })),
        }),
        description: "统计图表：bar 用于类目占比，line 用于按日趋势",
      },
      NewsList: {
        props: z.object({
          items: z.array(
            z.object({
              title_zh: z.string().nullable(),
              title: z.string(),
              summary_zh: z.string().nullable(),
              source: z.string(),
              heat: z.number(),
              published_at: z.string().nullable(),
              url: z.string(),
            }),
          ),
          dataTime: z.string().nullable(),
        }),
        description: "新闻列表：中文译题/摘要为主，原题与原文链接必带；dataTime 注明数据时间",
      },
      NewsItem: {
        props: z.object({
          title_zh: z.string().nullable(),
          title: z.string(),
          summary_zh: z.string().nullable(),
          source: z.string(),
          heat: z.number(),
          published_at: z.string().nullable(),
          url: z.string(),
        }),
        description: "单条新闻",
      },
      EmptyState: {
        props: z.object({ message: z.string() }),
        description: "空结果状态",
      },
      ErrorState: {
        props: z.object({
          message: z.string(),
          retryable: z.boolean().nullable(),
        }),
        description: "错误状态，retryable=true 时显示重试按钮",
      },
    },
    actions: {
      bill_create: {
        params: z.object({ op_id: z.string() }),
        description: "确认保存新账单",
      },
      bill_update: {
        params: z.object({ op_id: z.string() }),
        description: "确认修改账单",
      },
      bill_delete: {
        params: z.object({ op_id: z.string() }),
        description: "确认删除账单",
      },
      cancel_op: {
        params: z.object({ op_id: z.string() }),
        description: "取消当前提议",
      },
    },
  });
}
