import { defineAsyncComponent, type Component } from "vue";
import { defineRegistry } from "@json-render/vue";

/** 懒加载组件：`() => import("xxx.vue")` 的产物（default 导出为组件）。 */
export type LazyComponent = () => Promise<{ default: Component }>;

export interface WebFeatureContext {
  /** 注册渲染组件：函数形式视为懒加载器，装配时包 defineAsyncComponent。 */
  component(type: string, comp: Component | LazyComponent): void;
}

export interface WebFeature {
  name: string;
  register(ctx: WebFeatureContext): void;
}

/** 声明一个 web feature（目录约定 features/<name>/web/index.ts 的 default 导出）。 */
export function defineWebFeature(
  name: string,
  register: (ctx: WebFeatureContext) => void,
): WebFeature {
  return { name, register };
}

/** 约定：函数形式一律按懒加载器处理（defineAsyncComponent 仅接受加载函数）。 */
function toRegistryComponent(comp: Component | LazyComponent): Component {
  return typeof comp === "function" ? defineAsyncComponent(comp as LazyComponent) : comp;
}

/**
 * 组装 web registry：按路径排序加载各 feature 模块（import.meta.glob 的产物），
 * 取其 default 导出（WebFeature）收集组件。路径含 /kernel/ 的模块一律排除以防自吸。
 * 键冲突 fail-fast：同一 type 重复注册直接抛错。
 * 注意：异步函数，调用方需 top-level await。
 */
export async function assembleWebRegistry(
  modules: Record<string, () => Promise<unknown>>,
): Promise<Record<string, Component>> {
  const components: Record<string, Component> = {};
  for (const path of Object.keys(modules).sort()) {
    if (path.includes("/kernel/")) continue; // 防自吸：kernel 目录不是 feature
    const feature = ((await modules[path]()) as { default?: WebFeature }).default;
    if (!feature) throw new Error(`web feature 缺少 default 导出: ${path}`);
    feature.register({
      component: (type, comp) => {
        if (type in components) {
          throw new Error(`组件冲突: ${type}（feature ${feature.name} 重复注册）`);
        }
        components[type] = toRegistryComponent(comp);
      },
    });
  }
  return defineRegistry({ data: {} } as never, {
    components,
  }).registry as Record<string, Component>;
}
