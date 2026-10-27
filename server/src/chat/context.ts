import type Database from "better-sqlite3";
import type { ModelMsg } from "./llm";
import { createMessagesService } from "../messages/messages.service";
import { createOpsService } from "../ops/ops.service";
import { CATALOG_PROMPT, SKILLS_PROMPT } from "../agent/prompts";

const MAX_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 12000;

const PERSONA = `你是一个简洁友好的中文个人助理，运行在用户的本地聊天工具里。
今天日期：{{TODAY}}。

{{SKILLS}}

{{CATALOG}}`;

function todayInShanghai(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
}

/** 从存储的 spec（JSONL 行数组）提取组件类型做一行摘要。 */
function compressSpec(specJson: string): string {
  try {
    const lines: string[] = JSON.parse(specJson);
    const types = new Set<string>();
    for (const line of lines) {
      try {
        const patch = JSON.parse(line) as { value?: { type?: string } };
        if (patch?.value?.type) types.add(patch.value.type);
      } catch {
        // 忽略坏行
      }
    }
    return types.size > 0 ? `[卡片: ${[...types].join(", ")}]` : "[卡片: UI]";
  } catch {
    return "[卡片: UI]";
  }
}

export function buildContext(db: Database): { system: string; messages: ModelMsg[] } {
  const svc = createMessagesService(db);
  // listMessages 新→旧，反转为时间正序
  const recent = svc.listMessages({ limit: MAX_MESSAGES }).reverse();

  const messages: ModelMsg[] = recent.map((m) => {
    let content = m.content_text;
    if (m.role === "assistant" && m.spec_json) {
      content = `${content}\n${compressSpec(m.spec_json)}`;
    }
    return { role: m.role, content };
  });

  // 超长从最旧处截断
  while (messages.length > 1) {
    const total = messages.reduce((n, m) => n + m.content.length, 0);
    if (total <= MAX_CONTEXT_CHARS) break;
    messages.shift();
  }

  const system = PERSONA.replace("{{TODAY}}", todayInShanghai())
    .replace("{{SKILLS}}", SKILLS_PROMPT)
    .replace("{{CATALOG}}", CATALOG_PROMPT);

  const pending = createOpsService(db).getPendingSummary();
  const pendingLine = pending ? `\n\n当前待确认提议: ${pending}` : "";

  return { system: system + pendingLine, messages };
}
