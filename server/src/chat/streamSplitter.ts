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
 * 剥离 ``` 围栏标记（含粘连在句尾的情况）；形如 RFC6902 patch 的行判为 spec，其余为文本。
 */
export function createSpecSplitter(): {
  feed(chunk: string): Iterable<SplitEvent>;
  /** 把行缓冲中尚未换行的散文立即吐出（轮次边界用，不终止流） */
  flushLine(): SplitEvent[];
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
    const fenceIdx = line.indexOf("```");
    if (fenceIdx >= 0) {
      // 围栏标记可能被模型粘连在句尾（不在行首）：标记与语言标签剥离，标记前的正文保留。
      // 语言标签形如 spec/json 等拉丁词；其后是中文等正文则视为普通反引号文本，整行保留。
      const rest = line.slice(fenceIdx + 3).trim();
      const isFence = rest === "" || /^[A-Za-z0-9_-]+$/.test(rest);
      if (!isFence) {
        yield { kind: "text", delta: hadNewline ? `${line}\n` : line };
        return;
      }
      const prefix = line.slice(0, fenceIdx);
      if (prefix.trim().length > 0) {
        yield { kind: "text", delta: hadNewline ? `${prefix}\n` : prefix };
      }
      return;
    }
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
    /** 轮次边界：把行缓冲中尚未换行的散文立即吐出（跨轮叙述不合并成一整行）。 */
    flushLine(): SplitEvent[] {
      if (buffer.length === 0) return [];
      const rest = buffer;
      buffer = "";
      return [...handleLine(rest, false)];
    },
    end(): SplitEvent[] {
      return [...processBuffer(true)];
    },
  };
}
