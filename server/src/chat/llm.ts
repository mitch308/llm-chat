import OpenAI from "openai";

/** 模型侧工具调用（arguments 为 JSON 字符串）。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 与 OpenAI 兼容格式的工具定义。 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** 多轮对话消息（agent 循环回喂用）。 */
export interface ModelMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type Delta =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export interface LLMClient {
  stream(input: {
    system: string;
    messages: ModelMsg[];
    tools: ToolDef[];
  }): AsyncIterable<Delta>;
}

export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZHIPU_MODEL = "glm-5.3-flash";

/** 智谱兼容端点客户端：文本增量直通，tool_calls 累积后一次性吐出。 */
export function createZhipuClient(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): LLMClient {
  if (!opts.apiKey) throw new Error("ZHIPU_API_KEY missing");
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl ?? ZHIPU_BASE_URL,
  });
  const model = opts.model ?? ZHIPU_MODEL;

  async function* stream(input: {
    system: string;
    messages: ModelMsg[];
    tools: ToolDef[];
  }): AsyncIterable<Delta> {
    const completion = await client.chat.completions.create({
      model,
      stream: true,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ ...m }) as OpenAI.ChatCompletionMessageParam),
      ],
      ...(input.tools.length > 0 ? { tools: input.tools as never } : {}),
    });

    const acc = new Map<number, ToolCall>();
    for await (const chunk of completion) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const text = choice.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "text", delta: text };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const cur =
          acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        acc.set(tc.index, cur);
      }
    }
    if (acc.size > 0) {
      yield { type: "tool_calls", calls: [...acc.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) };
    }
  }

  return { stream };
}

/** 测试替身：每次 stream() 弹出一个脚本轮次。 */
export function createFakeLLM(script: Delta[][]): LLMClient {
  let round = 0;
  return {
    async *stream() {
      const deltas = script[round];
      if (!deltas) throw new Error(`fake LLM script exhausted at round ${round}`);
      round += 1;
      for (const d of deltas) yield d;
    },
  };
}
