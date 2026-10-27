export type SplitEvent =
  | { kind: "text"; delta: string }
  | { kind: "spec"; line: string };

function isSpecLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const obj = JSON.parse(trimmed) as { op?: string; path?: string };
    return typeof obj.op === "string" && typeof obj.path === "string";
  } catch {
    return false;
  }
}

/**
 * inline 模式分离器：完整行才能判定；行缓冲跨 chunk 断行；
 * 剥离 ``` 围栏行；形如 RFC6902 patch 的行判为 spec，其余为文本。
 */
export function createSpecSplitter(): {
  feed(chunk: string): Iterable<SplitEvent>;
  end(): SplitEvent[];
} {
  let buffer = "";

  function* processBuffer(flush: boolean): Iterable<SplitEvent> {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield* handleLine(line, true);
    }
    if (flush && buffer.length > 0) {
      const rest = buffer;
      buffer = "";
      yield* handleLine(rest, false);
    }
  }

  function* handleLine(line: string, hadNewline: boolean): Iterable<SplitEvent> {
    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith("```")) return; // 围栏行剥离
    if (isSpecLine(line)) {
      yield { kind: "spec", line: line.trim() };
    } else {
      yield { kind: "text", delta: hadNewline ? `${line}\n` : line };
    }
  }

  return {
    feed(chunk: string): Iterable<SplitEvent> {
      buffer += chunk;
      return processBuffer(false);
    },
    end(): SplitEvent[] {
      return [...processBuffer(true)];
    },
  };
}
