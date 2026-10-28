import { assembleWebRegistry } from "@llm-chat/features/web";

/** catalog 定义在 server（feature 贡献组装）；web 侧按 features/<name>/web/index.ts
 *  约定 glob 收集 feature 的 default 导出并组装 类型→组件 映射（懒加载）。 */
const mods = import.meta.glob("../../../features/*/web/index.ts");

// TLA：assembleWebRegistry 需先 await 各 feature 模块；排除 /kernel/ 由组装器负责
export const registry = await assembleWebRegistry(mods);
