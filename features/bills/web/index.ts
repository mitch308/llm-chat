import { defineWebFeature } from "@llm-chat/features/web";
import { BILL_COMPONENTS } from "../shared";

/**
 * bills 的 web 侧注册：组件类型逐一取自 shared.ts 的 BILL_COMPONENTS 清单
 * （顺序即清单顺序：BillConfirmCard/BillList/BillItem），全部懒加载分包。
 */
export default defineWebFeature("bills", (ctx) => {
  ctx.component(BILL_COMPONENTS[0], () => import("./BillConfirmCard.vue"));
  ctx.component(BILL_COMPONENTS[1], () => import("./BillList.vue"));
  ctx.component(BILL_COMPONENTS[2], () => import("./BillItem.vue"));
});
