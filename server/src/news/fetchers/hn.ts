import type { NewsFetcher, RawItem } from "../sources";
import { fetchWithTimeout } from "../sources";

const BASE = "https://hn.algolia.com/api/v1";

interface HnHit {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  created_at: string | null;
}

/** Hacker News（Algolia）：真实热度 points 归一化；支持日期区间。 */
export function createHnFetcher(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): NewsFetcher {
  async function query(search: URLSearchParams): Promise<RawItem[]> {
    const res = await fetchWithTimeout(`${BASE}/search?${search.toString()}`, {}, opts);
    if (!res.ok) throw new Error(`hackernews 返回 ${res.status}`);
    const data = (await res.json()) as { hits: HnHit[] };
    return (data.hits ?? []).map((h) => ({
      external_id: h.objectID,
      title: h.title ?? "(无标题)",
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      published_at: h.created_at,
      heat_score: Math.min(100, Math.round(((h.points ?? 0) / 500) * 100)),
    }));
  }

  return {
    source: "hackernews",
    supportsRange: true,
    fetchLatest: () =>
      query(new URLSearchParams({ tags: "front_page", hitsPerPage: "30" })),
    fetchRange: (from, to) => {
      const fromTs = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
      const toTs = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);
      return query(
        new URLSearchParams({
          tags: "story",
          hitsPerPage: "30",
          numericFilters: `created_at_i>${fromTs},created_at_i<${toTs}`,
        }),
      );
    },
  };
}
