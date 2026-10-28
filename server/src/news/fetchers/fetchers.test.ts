import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRssFetcher } from "./rss";
import { createHnFetcher } from "./hn";
import { createGuardianFetcher } from "./guardian";

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>新华网</title>
<item>
  <title>新闻一</title>
  <link>https://example.com/a</link>
  <guid isPermaLink="false">guid-a</guid>
  <pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>
</item>
<item>
  <title>新闻二</title>
  <link>https://example.com/b</link>
  <guid isPermaLink="false">guid-b</guid>
  <pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate>
  <enclosure url="https://example.com/img.jpg" type="image/jpeg"/>
</item>
</channel></rss>`;

describe("createRssFetcher", () => {
  it("parses fixture XML into RawItems with guid ids and rank-derived heat", async () => {
    const urls: string[] = [];
    const fetcher = createRssFetcher("xinhua", "https://rsshub.test/xinhuanet/news", {
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return new Response(RSS_XML, { status: 200 });
      }) as typeof fetch,
    });

    const items = await fetcher.fetchLatest();
    expect(urls).toEqual(["https://rsshub.test/xinhuanet/news"]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      external_id: "guid-a",
      title: "新闻一",
      url: "https://example.com/a",
    });
    expect(items[1].external_id).toBe("guid-b");
    // 前排热度更高
    expect(items[0].heat_score!).toBeGreaterThan(items[1].heat_score!);
    expect(fetcher.supportsRange).toBe(false);
  });

  it("rejects on timeout when fetch hangs", async () => {
    const fetcher = createRssFetcher("bbc", "https://feeds.test/bbc", {
      timeoutMs: 20,
      fetchImpl: (async () => {
        await new Promise(() => {});
      }) as unknown as typeof fetch,
    });
    await expect(fetcher.fetchLatest()).rejects.toThrow(/超时|timeout/i);
  });
});

describe("createHnFetcher", () => {
  const ALGOLIA = {
    hits: [
      {
        objectID: "hn-1",
        title: "Show HN: json-render",
        url: "https://json-render.dev",
        points: 300,
        created_at: "2026-10-26T10:00:00Z",
      },
      {
        objectID: "hn-2",
        title: "Local LLM agents",
        url: null,
        points: 30,
        created_at: "2026-10-26T11:00:00Z",
      },
    ],
  };

  it("parses Algolia JSON and normalizes points to heat", async () => {
    const fetcher = createHnFetcher({
      fetchImpl: (async () => new Response(JSON.stringify(ALGOLIA), { status: 200 })) as typeof fetch,
    });

    const items = await fetcher.fetchLatest();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ external_id: "hn-1", title: "Show HN: json-render" });
    expect(items[0].url).toBe("https://json-render.dev");
    expect(items[0].heat_score!).toBeGreaterThan(items[1].heat_score!);
    // url 缺失时回退 HN 讨论页
    expect(items[1].url).toContain("news.ycombinator.com");
    expect(fetcher.supportsRange).toBe(true);
  });

  it("fetchRange URL contains created_at_i filters", async () => {
    const urls: string[] = [];
    const fetcher = createHnFetcher({
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      }) as typeof fetch,
    });

    await fetcher.fetchRange!("2026-10-01", "2026-10-07");
    expect(urls[0]).toContain("created_at_i");
    expect(urls[0]).toContain("algolia");
  });
});

describe("createGuardianFetcher", () => {
  beforeEach(() => {
    delete process.env.GUARDIAN_API_KEY;
  });
  afterEach(() => {
    delete process.env.GUARDIAN_API_KEY;
  });

  it("rejects with SOURCE_DISABLED without an api key", async () => {
    const fetcher = createGuardianFetcher({ apiKey: "" });
    await expect(fetcher.fetchLatest()).rejects.toThrow("SOURCE_DISABLED");
  });

  it("parses the open API payload", async () => {
    const payload = {
      response: {
        results: [
          {
            id: "world/2026/oct/26/some-story",
            webTitle: "Some story",
            webUrl: "https://theguardian.com/world/2026/oct/26/some-story",
            webPublicationDate: "2026-10-26T09:00:00Z",
          },
        ],
      },
    };
    const fetcher = createGuardianFetcher({
      apiKey: "test-key",
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    });

    const items = await fetcher.fetchLatest();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      external_id: "world/2026/oct/26/some-story",
      title: "Some story",
      url: "https://theguardian.com/world/2026/oct/26/some-story",
    });
    expect(fetcher.supportsRange).toBe(true);
  });
});
