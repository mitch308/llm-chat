import { parseSseChunk } from "../chat/sse";
import type { AgentEvent, ServerMessage } from "../chat/types";

/** POST /api/chat，流式消费 SSE，逐事件回调。 */
export async function streamChat(
  content: string,
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) {
    const message = await res.text().catch(() => "");
    throw new Error(`chat failed: ${res.status} ${message}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const e of events) onEvent(e);
  }
  if (buffer.length > 0) {
    const { events } = parseSseChunk(buffer + "\n\n");
    for (const e of events) onEvent(e);
  }
}

export async function getMessages(opts: {
  beforeId?: number;
  limit?: number;
}): Promise<{ items: ServerMessage[] }> {
  const params = new URLSearchParams();
  if (opts.beforeId) params.set("before_id", String(opts.beforeId));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetch(`/api/messages${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`getMessages failed: ${res.status}`);
  return res.json();
}

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
