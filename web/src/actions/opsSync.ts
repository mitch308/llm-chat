import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

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
