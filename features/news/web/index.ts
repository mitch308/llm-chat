import { defineWebFeature } from "@llm-chat/features/web";
import { NEWS_COMPONENTS } from "../shared";

/**
 * news 的 web 侧注册：组件类型逐一取自 shared.ts 的 NEWS_COMPONENTS 清单
 * （顺序即清单顺序：NewsList/NewsItem），全部懒加载分包。
 */
export default defineWebFeature("news", (ctx) => {
  ctx.component(NEWS_COMPONENTS[0], () => import("./NewsList.vue"));
  ctx.component(NEWS_COMPONENTS[1], () => import("./NewsItem.vue"));
});
