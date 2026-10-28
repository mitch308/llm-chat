import type { NewsFetcher, SourceId } from "./sources";
import { createRssFetcher } from "./fetchers/rss";
import { createHnFetcher } from "./fetchers/hn";
import { createGuardianFetcher } from "./fetchers/guardian";

const RSSHUB_BASE = process.env.RSSHUB_BASE ?? "https://rsshub.app";

/** 7 个新闻源注册表（spec 第 10 节）。仅查询时按需触发，无任何定时轮询。 */
export function buildSourceFetchers(opts?: {
  fetchImpl?: typeof fetch;
  guardianApiKey?: string;
}): Record<SourceId, NewsFetcher> {
  const common = { fetchImpl: opts?.fetchImpl };
  return {
    xinhua: createRssFetcher("xinhua", `${RSSHUB_BASE}/xinhuanet/news`, common),
    people: createRssFetcher("people", `${RSSHUB_BASE}/people/news`, common),
    sina: createRssFetcher("sina", `${RSSHUB_BASE}/sina/roll`, common),
    hackernews: createHnFetcher(common),
    bbc: createRssFetcher("bbc", "https://feeds.bbci.co.uk/news/rss.xml", common),
    guardian: createGuardianFetcher({ ...common, apiKey: opts?.guardianApiKey }),
    techcrunch: createRssFetcher("techcrunch", "https://techcrunch.com/feed/", common),
  };
}

export const SOURCE_IDS: SourceId[] = [
  "xinhua",
  "people",
  "sina",
  "hackernews",
  "bbc",
  "guardian",
  "techcrunch",
];
