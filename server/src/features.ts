import {
  assembleServerFeatures,
  scanServerFeatures,
  type AssembledServer,
} from "@llm-chat/features/server";

/**
 * 全局装配（ASM）：模块加载时扫描仓库根 features/ 并组装——
 * 凡含 server/index.ts 的子目录即一个 server feature（目录名排序 = 注册顺序），
 * 删除/改名目录即从装配中移除该 feature，无需改此文件。
 * 路径说明：本文件位于 server/src/，../../features/ 即仓库根 features/。
 */
export const ASM: AssembledServer = assembleServerFeatures(
  await scanServerFeatures(new URL("../../features/", import.meta.url)),
);
