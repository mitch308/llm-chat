import { postAction } from "../api/client";

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
