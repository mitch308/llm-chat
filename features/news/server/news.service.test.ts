import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../../../server/src/db/connection";
import { createFakeLLM, type LLMClient } from "../../../server/src/chat/llm";
import type { NewsFetcher, RawItem, SourceId } from "./sources";
import { createNewsService } from "./news.service";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-news-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const ALL: SourceId[] = [
  "xinhua",
  "people",
  "sina",
  "hackernews",
  "bbc",
  "guardian",
  "techcrunch",
];

interface Counters {
  latest: Record<string, number>;
  range: Record<string, number>;
}

function fakeFetchers(items: Partial<Record<SourceId, RawItem[]>> = {}, c: Counters) {
  const fetchers = {} as Record<SourceId, NewsFetcher>;
  for (const sid of ALL) {
    const supportsRange = sid === "hackernews" || sid === "guardian";
    fetchers[sid] = {
      source: sid,
      supportsRange,
      fetchLatest: async () => {
        c.latest[sid] = (c.latest[sid] ?? 0) + 1;
        return items[sid] ?? [];
      },
      ...(supportsRange
        ? {
            fetchRange: async () => {
              c.range[sid] = (c.range[sid] ?? 0) + 1;
              return items[sid] ?? [];
            },
          }
        : {}),
    };
  }
  return fetchers;
}

function insertNews(source: SourceId, externalId: string, title: string, extra: Partial<{ title_zh: string; description: string; foreign: boolean }> = {}) {
  db.prepare(
    `INSERT INTO news_items (source, external_id, title, title_zh, url, published_at, heat_score, fetched_at, description)
     VALUES (?, ?, ?, ?, ?, ?, 10, datetime('now'), ?)`,
  ).run(source, externalId, title, extra.title_zh ?? null, `https://x/${externalId}`, "2026-10-27T08:00:00Z", extra.description ?? null);
}

/** 让全部来源都持有新鲜缓存（fetched_at=now），断言"零抓取"才成立。 */
function seedFreshCacheForAll() {
  for (const sid of ALL) {
    db.prepare(
      `INSERT INTO news_items (source, external_id, title, url, published_at, heat_score, fetched_at)
       VALUES (?, ?, ?, ?, ?, 5, datetime('now'))`,
    ).run(sid, `fresh-${sid}`, `${sid} 基线新闻`, `https://x/${sid}`, "2026-10-27T07:00:00Z");
  }
}

describe("searchNews", () => {
  it("keyword mode hits FTS across multiple OR keywords without refetching fresh cache", async () => {
    const c: Counters = { latest: {}, range: {} };
    seedFreshCacheForAll();
    insertNews("xinhua", "n1", "国产 LLM 新突破");
    insertNews("people", "n2", "两会召开");
    insertNews("sina", "n3", "AI 芯片涨价");

    const svc = createNewsService({ db, fetchers: fakeFetchers({}, c) });
    const res = await svc.searchNews({ keywords: ["AI", "LLM"], mode: "keyword" });

    expect(res.items.map((i) => i.external_id).sort()).toEqual(["n1", "n3"]);
    // 缓存新鲜：不问不查，fetchers 零调用
    expect(Object.values(c.latest).reduce((a, b) => a + b, 0)).toBe(0);
    expect(Object.values(c.range).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("degrades to LIKE search when fts5 is unavailable (Review Focus #5)", async () => {
    const c: Counters = { latest: {}, range: {} };
    seedFreshCacheForAll();
    insertNews("xinhua", "n1", "国产 LLM 新突破");
    insertNews("people", "n2", "两会召开");

    const svc = createNewsService({ db, fetchers: fakeFetchers({}, c), fts5Enabled: false });
    const res = await svc.searchNews({ keywords: ["LLM"], mode: "keyword" });
    expect(res.items.map((i) => i.external_id)).toEqual(["n1"]);
    expect(Object.values(c.latest).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("stale cache triggers exactly one parallel refetch per source", async () => {
    const c: Counters = { latest: {}, range: {} };
    seedFreshCacheForAll();
    insertNews("xinhua", "n1", "旧新闻");
    db.prepare(
      `UPDATE news_items SET fetched_at = datetime('now', '-40 minutes') WHERE source = 'xinhua'`,
    ).run();

    const svc = createNewsService({
      db,
      fetchers: fakeFetchers(
        { xinhua: [{ external_id: "new-1", title: "新 LLM 发布", url: "https://x/new", published_at: null, heat_score: 60 }] },
        c,
      ),
    });
    const res = await svc.searchNews({ keywords: ["LLM"], mode: "keyword" });
    expect(c.latest["xinhua"]).toBe(1);
    expect(Object.values(c.latest).reduce((a, b) => a + b, 0)).toBe(1);
    expect(res.items.map((i) => i.external_id)).toContain("new-1");
  });

  it("historical range: only range-capable sources fetched, others skipped", async () => {
    const c: Counters = { latest: {}, range: {} };
    const svc = createNewsService({
      db,
      fetchers: fakeFetchers(
        {
          hackernews: [{ external_id: "hn-hist", title: "old AI post", url: "https://hn/1", published_at: null, heat_score: 10 }],
          guardian: [],
        },
        c,
      ),
    });

    const res = await svc.searchNews({
      keywords: ["AI"],
      mode: "keyword",
      from: "2026-09-01",
      to: "2026-09-30",
    });

    expect(c.range["hackernews"]).toBe(1);
    expect(c.range["guardian"]).toBe(1);
    expect(c.latest["xinhua"] ?? 0).toBe(0);
    expect(res.skippedSources.sort()).toEqual(["bbc", "people", "sina", "techcrunch", "xinhua"]);
    expect(res.items.map((i) => i.external_id)).toContain("hn-hist");
  });

  it("all sources unsupported for the range → unsupported:true", async () => {
    const c: Counters = { latest: {}, range: {} };
    const svc = createNewsService({ db, fetchers: fakeFetchers({}, c) });
    const res = await svc.searchNews({
      keywords: ["x"],
      mode: "keyword",
      source: "bbc",
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(res.unsupported).toBe(true);
    expect(res.items).toHaveLength(0);
    expect(res.skippedSources).toEqual(["bbc"]);
  });

  it("translation runs in background: search responds first, flush persists the cache", async () => {
    const c: Counters = { latest: {}, range: {} };
    const html = "<html><body><article><h1>Big AI Release</h1><p>" + "A very long story. ".repeat(30) + "</p></article></body></html>";
    // 受控 LLM：release 之前不吐译文 → 证明 searchNews 不等翻译
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm: LLMClient = {
      async *stream() {
        await gate;
        yield {
          type: "text",
          delta: JSON.stringify([
            { external_id: "hn-1", title_zh: "AI 大发布", summary_zh: "某公司发布了新模型，性能大幅提升，社区反响热烈，值得关注后续生态进展。" },
          ]),
        };
      },
    };

    const svc = createNewsService({
      db,
      llm,
      fetchers: fakeFetchers({}, c),
      articleFetch: async () => new Response(html, { status: 200 }),
    });
    insertNews("hackernews", "hn-1", "Big AI Release");

    const res = await svc.searchNews({ keywords: ["AI"], mode: "keyword" });
    // 不等翻译：响应先回，译文还没生成
    expect(res.items[0].title_zh).toBeNull();

    release();
    await svc.flushTranslations();

    // 译文入库；再查一次带出译文，且不再触发抓取与 LLM
    const svc2 = createNewsService({
      db,
      llm: createFakeLLM([]),
      fetchers: fakeFetchers({}, c),
      articleFetch: async () => {
        throw new Error("should not refetch");
      },
    });
    const res2 = await svc2.searchNews({ keywords: ["AI"], mode: "keyword" });
    expect(res2.items[0].title_zh).toBe("AI 大发布");
    expect(res2.items[0].summary_zh!.length).toBeLessThanOrEqual(100);
  });

  it("article extraction failure degrades to RSS description, then to no summary", async () => {
    const c: Counters = { latest: {}, range: {} };
    const llm: LLMClient = createFakeLLM([
      [
        {
          type: "text",
          delta: JSON.stringify([
            { external_id: "bbc-1", title_zh: "BBC 中文题", summary_zh: "据 BBC 报道的简要内容概括。" },
            { external_id: "tc-1", title_zh: "TC 中文题", summary_zh: "TechCrunch 简要内容。" },
          ]),
        },
      ],
    ]);

    db.prepare(`DELETE FROM news_items`).run();
    insertNews("bbc", "bbc-1", "BBC story", { description: "BBC feed snippet about the story." });
    insertNews("techcrunch", "tc-1", "TC story");

    const svc = createNewsService({
      db,
      llm,
      fetchers: fakeFetchers({}, c),
      articleFetch: async () => new Response("not html", { status: 500 }),
    });
    const res = await svc.searchNews({ keywords: ["story"], mode: "keyword" });

    // 响应先行：译文字段尚未生成
    expect(res.items.find((i) => i.external_id === "bbc-1")!.title_zh).toBeNull();

    await svc.flushTranslations();

    // 译文入库后再查带出
    const res2 = await svc.searchNews({ keywords: ["story"], mode: "keyword" });
    const bbc = res2.items.find((i) => i.external_id === "bbc-1")!;
    const tc = res2.items.find((i) => i.external_id === "tc-1")!;
    expect(bbc.title_zh).toBe("BBC 中文题");
    expect(bbc.summary_zh).toBe("据 BBC 报道的简要内容概括。");
    expect(tc.summary_zh).toBe("TechCrunch 简要内容。"); // description 也缺失 → 仅译题
  });

  it("refreshing a cached foreign item preserves its Chinese title in FTS (I2)", async () => {
    const c: Counters = { latest: {}, range: {} };
    insertNews("techcrunch", "tc-1", "Some AI story", { title_zh: "人工智能报道" });
    db.prepare(
      `UPDATE news_items SET fetched_at = datetime('now', '-40 minutes') WHERE external_id = 'tc-1'`,
    ).run();

    const svc = createNewsService({
      db,
      llm: createFakeLLM([]),
      fetchers: fakeFetchers(
        {
          techcrunch: [
            { external_id: "tc-1", title: "Some AI story", url: "https://x/tc1", published_at: null, heat_score: 30 },
          ],
        },
        c,
      ),
    });

    // 刷新后再用中文关键词检索，仍应命中（FTS 的 title_zh 未被 REPLACE 抹掉）
    const res = await svc.searchNews({ keywords: ["人工智能报道"], mode: "keyword" });
    expect(res.items.map((i) => i.external_id)).toContain("tc-1");
  });

  it("keyword mode applies the from/to date range (I3)", async () => {
    const c: Counters = { latest: {}, range: {} };
    seedFreshCacheForAll();
    db.prepare(`DELETE FROM news_items WHERE external_id LIKE 'fresh-%'`).run();
    db.prepare(
      `INSERT INTO news_items (source, external_id, title, url, published_at, heat_score, fetched_at)
       VALUES ('xinhua','wk-old','上周的AI新闻','https://x/old','2026-10-20T08:00:00Z',10,datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO news_items (source, external_id, title, url, published_at, heat_score, fetched_at)
       VALUES ('xinhua','wk-new','今天的AI新闻','https://x/new','2026-10-26T08:00:00Z',10,datetime('now'))`,
    ).run();

    const svc = createNewsService({ db, fetchers: fakeFetchers({}, c) });
    const res = await svc.searchNews({
      keywords: ["AI"],
      mode: "keyword",
      from: "2026-10-25",
      to: "2026-10-27",
    });
    expect(res.items.map((i) => i.external_id)).toEqual(["wk-new"]);
  });

  it("LLM summary failure never blocks the search", async () => {
    const c: Counters = { latest: {}, range: {} };
    insertNews("hackernews", "hn-9", "Some AI thing");
    const svc = createNewsService({
      db,
      llm: {
        stream: async function* () {
          throw new Error("llm down");
        },
      },
      fetchers: fakeFetchers({}, c),
      articleFetch: async () => new Response("<html><body><p>text</p></body></html>", { status: 200 }),
    });
    const res = await svc.searchNews({ keywords: ["AI"], mode: "keyword" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].title_zh).toBeNull();
  });
});
