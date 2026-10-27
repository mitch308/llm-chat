import type { NewsFetcher, RawItem } from "../sources";
import { fetchWithTimeout, heatFromRank } from "../sources";

const BASE = "https://content.guardianapis.com/search";

interface GuardianResult {
  id: string;
  webTitle: string;
  webUrl: string;
  webPublicationDate: string;
}

/** The Guardian 开放 API：支持日期区间；无 GUARDIAN_API_KEY 时该源禁用。 */
export function createGuardianFetcher(opts: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): NewsFetcher {
  const apiKey = opts.apiKey ?? process.env.GUARDIAN_API_KEY ?? "";

  async function query(search: URLSearchParams): Promise<RawItem[]> {
    if (!apiKey) throw new Error("SOURCE_DISABLED");
    search.set("api-key", apiKey);
    const res = await fetchWithTimeout(`${BASE}?${search.toString()}`, {}, opts);
    if (!res.ok) throw new Error(`guardian 返回 ${res.status}`);
    const data = (await res.json()) as { response?: { results?: GuardianResult[] } };
    const results = data.response?.results ?? [];
    return results.map((r, rank) => ({
      external_id: r.id,
      title: r.webTitle,
      url: r.webUrl,
      published_at: r.webPublicationDate,
      heat_score: heatFromRank(rank, results.length),
      rank,
    }));
  }

  return {
    source: "guardian",
    supportsRange: true,
    fetchLatest: () =>
      query(new URLSearchParams({ "page-size": "30", "order-by": "newest" })),
    fetchRange: (from, to) =>
      query(
        new URLSearchParams({
          "page-size": "30",
          "order-by": "newest",
          "from-date": from,
          "to-date": to,
        }),
      ),
  };
}
