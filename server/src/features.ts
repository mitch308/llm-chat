import {
  assembleServerFeatures,
  scanServerFeatures,
  type AssembledServer,
} from "@llm-chat/features/server";

/**
 * 全局装配（ASM）：模块加载时扫描仓库根 features/ 并组装。
 * 当前 features/ 无业务目录，为空装配——接线后行为与现状完全一致。
 * 路径说明：本文件位于 server/src/，../../features/ 即仓库根 features/。
 */
export const ASM: AssembledServer = assembleServerFeatures(
  await scanServerFeatures(new URL("../../features/", import.meta.url)),
);
