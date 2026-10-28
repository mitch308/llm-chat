import { z } from "zod";

/** 跨 feature 共享的通用组件清单；Props zod 自原 server/src/agent/catalog.ts 逐字迁移。 */
export const SHARED_COMPONENTS = ["Metric", "StatChart", "EmptyState", "ErrorState"] as const;

export const MetricProps = z.object({
  label: z.string(),
  value: z.string(),
  format: z.enum(["currency", "number", "percent"]).nullable(),
});

export const StatChartProps = z.object({
  chart: z.enum(["bar", "line"]),
  title: z.string().nullable(),
  series: z.array(z.object({ name: z.string(), value: z.number() })),
});

export const EmptyStateProps = z.object({ message: z.string() });

export const ErrorStateProps = z.object({
  message: z.string(),
  retryable: z.boolean().nullable(),
});
