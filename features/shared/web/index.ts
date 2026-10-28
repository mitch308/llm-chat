import { defineWebFeature } from "@llm-chat/features/web";
import { SHARED_COMPONENTS } from "../shared";

/**
 * shared 的 web 侧注册：组件类型逐一取自 shared.ts 的 SHARED_COMPONENTS 清单
 * （顺序即清单顺序：Metric/StatChart/EmptyState/ErrorState），全部懒加载分包。
 */
export default defineWebFeature("shared", (ctx) => {
  ctx.component(SHARED_COMPONENTS[0], () => import("./Metric.vue"));
  ctx.component(SHARED_COMPONENTS[1], () => import("./StatChart.vue"));
  ctx.component(SHARED_COMPONENTS[2], () => import("./EmptyState.vue"));
  ctx.component(SHARED_COMPONENTS[3], () => import("./ErrorState.vue"));
});
