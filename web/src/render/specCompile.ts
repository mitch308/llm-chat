import { compileSpecStream } from "@json-render/core";

/** 存储的 JSONL 行数组 → 编译后的 spec 对象。 */
export function linesToSpec(lines: string[]): Record<string, unknown> {
  return compileSpecStream(lines.join("\n")) as Record<string, unknown>;
}
