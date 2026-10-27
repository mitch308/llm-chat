import type { AgentEvent } from "./types";

/** 解析一段 SSE 字节流文本：完整 `data: {...}\n\n` 帧转事件，剩余不完整部分留在 rest。 */
export function parseSseChunk(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let rest = buffer;

  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice(6)) as AgentEvent);
    } catch {
      // 坏帧跳过，不中断流
    }
  }
  return { events, rest };
}
