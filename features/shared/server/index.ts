import { defineServerFeature } from "@llm-chat/features/server";
import {
  SHARED_COMPONENTS,
  EmptyStateProps,
  ErrorStateProps,
  MetricProps,
  StatChartProps,
} from "../shared";

/** shared feature：注册跨 feature 复用的通用组件（自原 server/src/agent/catalog.ts 迁移）。 */
export default defineServerFeature("shared", (ctx) => {
  ctx.catalogComponents({
    [SHARED_COMPONENTS[0]]: {
      props: MetricProps,
      description: "单个指标数值展示（如本月总支出 ¥2,340）",
    },
    [SHARED_COMPONENTS[1]]: {
      props: StatChartProps,
      description: "统计图表：bar 用于类目占比，line 用于按日趋势",
    },
    [SHARED_COMPONENTS[2]]: {
      props: EmptyStateProps,
      description: "空结果状态",
    },
    [SHARED_COMPONENTS[3]]: {
      props: ErrorStateProps,
      description: "错误状态，retryable=true 时显示重试按钮",
    },
  });
});
