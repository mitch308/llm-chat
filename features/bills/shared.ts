import { z } from "zod";

/**
 * bills 组件/动作清单（与 web/src/render/registry.ts 一一对应）。
 * Props zod 自原 server/src/agent/catalog.ts 逐字迁移；本文件保持 node-safe（仅 zod）。
 */
export const BILL_COMPONENTS = ["BillConfirmCard", "BillList", "BillItem"] as const;
export const BILL_ACTIONS = ["bill_create", "bill_update", "bill_delete"] as const;

export const BillConfirmCardProps = z.object({
  op_id: z.string(),
  kind: z.enum(["bill_create", "bill_update", "bill_delete"]).nullable(),
  status: z.enum(["pending", "saved", "executed", "cancelled", "expired", "error"]),
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
});

export const BillListProps = z.object({
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
});

export const BillItemProps = z.object({
  item: z.string(),
  categoryName: z.string(),
  amount_yuan: z.number(),
  type: z.enum(["expense", "income"]),
  date: z.string(),
});
