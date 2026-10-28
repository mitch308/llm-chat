import Parser from "rss-parser";
import type { NewsFetcher, RawItem, SourceId } from "../sources";
import { fetchWithTimeout, heatFromRank } from "../sources";

/** RSS/RSSHub 来源工厂：无历史区间支持；热度按频道内排名合成。 */
export function createRssFetcher(
  source: SourceId,
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): NewsFetcher {
  const parser = new Parser<{ item: Record<string, unknown> }>({
    customFields: { item: ["enclosure"] },
  });

  async function fetchUrl(): Promise<RawItem[]> {
    const res = await fetchWithTimeout(url, {}, opts);
    if (!res.ok) throw new Error(`来源 ${source} 返回 ${res.status}`);
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    const items = feed.items ?? [];
    return items.map((it, rank) => {
      const guid = it.guid ?? it.link ?? String(rank);
      const record = it as unknown as { content?: string; contentSnippet?: string };
      return {
        external_id: String(guid),
        title: it.title ?? "(无标题)",
        url: it.link ?? "",
        published_at: it.isoDate ?? null,
        heat_score: heatFromRank(rank, items.length),
        rank,
        description: record.contentSnippet ?? record.content ?? null,
      } satisfies RawItem;
    });
  }

  return {
    source,
    supportsRange: false,
    fetchLatest: fetchUrl,
  };
}
