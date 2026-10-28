export type SourceId =
  | "xinhua"
  | "people"
  | "sina"
  | "hackernews"
  | "bbc"
  | "guardian"
  | "techcrunch";

export interface RawItem {
  external_id: string;
  title: string;
  url: string;
  published_at: string | null;
  heat_score: number;
  rank?: number;
  /** RSS 简介/正文片段，作为正文抽取失败的降级来源。 */
  description?: string | null;
}

export interface NewsFetcher {
  source: SourceId;
  fetchLatest(): Promise<RawItem[]>;
  supportsRange: boolean;
  fetchRange?(from: string, to: string): Promise<RawItem[]>;
}

export type FetchImpl = typeof fetch;

/** 单来源抓取超时（spec：8s）。 */
export const FETCH_TIMEOUT_MS = 8_000;

/** 无真实热度数据时按排名合成 0-100（前排更高）。 */
export function heatFromRank(rank: number, total: number): number {
  if (total <= 1) return 80;
  return Math.max(5, Math.round(100 - (rank / total) * 90));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`来源抓取超时(${timeoutMs}ms): ${url}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      doFetch(url, { ...init, signal: controller.signal }) as Promise<Response>,
      timeout,
    ]);
  } finally {
    clearTimeout(timerHandle);
  }
}

/** 外文来源（需要译题+摘要）。 */
export const FOREIGN_SOURCES: SourceId[] = ["hackernews", "bbc", "guardian", "techcrunch"];
