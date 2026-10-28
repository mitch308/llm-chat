import {
  assembleServerFeatures,
  scanServerFeatures,
  type AssembledServer,
} from "@llm-chat/features/server";

/**
 * 全局装配（ASM）：模块加载时扫描仓库根 features/ 并组装——
 * 凡含 server/index.ts 的子目录即一个 server feature（目录名排序 = 注册顺序），
 * 将目录移出 features/（或整体删除）即从装配移除该 feature，无需改此文件；
 * 在 features/ 内改名不会移除——扫描只看目录内是否含 server/index.ts。
 * 路径说明：本文件位于 server/src/，../../features/ 即仓库根 features/。
 */
export const ASM: AssembledServer = assembleServerFeatures(
  await scanServerFeatures(new URL("../../features/", import.meta.url)),
);
