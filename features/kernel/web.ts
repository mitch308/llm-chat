import {
  defineAsyncComponent,
  h,
  inject,
  provide,
  ref,
  type Component,
  type InjectionKey,
  type Ref,
} from "vue";
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

/**
 * 约定：函数形式一律按懒加载器处理（defineAsyncComponent 仅接受加载函数）。
 * @json-render/vue 的 defineRegistry 会把组件项以 componentFn({props,...}) 调用并期望返回 VNode，
 * 故这里统一包一层 (ctx) => h(内层组件, ctx.props) 的函数式适配器（与原静态 registry 写法一致）。
 */
function toRegistryComponent(comp: Component | LazyComponent): Component {
  const inner: Component =
    typeof comp === "function" ? defineAsyncComponent(comp as LazyComponent) : comp;
  type Ctx = { props: Record<string, unknown> };
  return ((ctx: Ctx) => h(inner, ctx.props)) as unknown as Component;
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

// ---- op 网络设施（原 web/src/api/client.ts 的 postAction/getOps、原 web/src/actions/*）逐字收编 ----

export async function postAction(
  name: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // 附上服务端错误码（如 OP_EXPIRED），供卡片按语义翻转状态
    throw Object.assign(
      new Error((data.message as string) ?? `action failed: ${res.status}`),
      { code: data.code },
    );
  }
  return data;
}

export async function getOps(opIds: string[]): Promise<{ items: unknown[] }> {
  if (opIds.length === 0) return { items: [] };
  const res = await fetch(`/api/ops?op_ids=${encodeURIComponent(opIds.join(","))}`);
  if (!res.ok) throw new Error(`getOps failed: ${res.status}`);
  return res.json();
}

export interface ActionResult {
  status: string;
  bill?: Record<string, unknown> | null;
  quip?: string | null;
  deleted?: boolean;
  [key: string]: unknown;
}

/** 确认按钮动作：POST /api/actions/:name；错误转为对用户友好的 message 抛出。 */
export async function handleAction(
  name: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  try {
    return (await postAction(name, params)) as ActionResult;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error("连接失败，请稍后重试");
    }
    throw err;
  }
}

const OpsSyncKey: InjectionKey<Ref<number>> = Symbol("ops-sync");

export { OpsSyncKey };

/**
 * 每轮对话结束自增的对账信号。
 * 文字"确认"路径由服务端 execute_op 直接落库，卡片没有按钮点击可依赖，
 * pending 卡片监听该信号后重新 getOps 核对真实状态并翻转。
 */
export function provideOpsSync(): Ref<number> {
  const version = ref(0);
  provide(OpsSyncKey, version);
  return version;
}

export function useOpsSync(): Ref<number> | undefined {
  return inject(OpsSyncKey, undefined);
}
