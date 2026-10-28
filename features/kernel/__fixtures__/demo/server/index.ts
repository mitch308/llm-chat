import { defineServerFeature } from "../../../server";

/** 扫描测试夹具：模拟一个最小 feature 目录。 */
export default defineServerFeature("demo", (ctx) => {
  ctx.ddl("SELECT 1");
});
