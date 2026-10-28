import type Database from "better-sqlite3";
import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import type { LLMClient } from "../../../server/src/chat/llm";
import type { NewsFetcher, RawItem, SourceId } from "./sources";
import { FOREIGN_SOURCES } from "./sources";
import { isFts5Enabled } from "@llm-chat/features/server";

export interface NewsItem {
  id: number;
  source: SourceId;
  external_id: string;
  title: string;
  title_zh: string | null;
  summary_zh: string | null;
  url: string;
  published_at: string | null;
  heat_score: number;
}

export interface NewsSearchResult {
  items: NewsItem[];
  dataTime: string;
  skippedSources: SourceId[];
  unsupported?: boolean;
  failedSources: SourceId[];
}

export interface SearchNewsQuery {
  keywords: string[];
  mode: "keyword" | "hot";
  source?: SourceId;
  from?: string;
  to?: string;
  limit?: number;
}

const TTL_MINUTES = 30;
const RECENT_WINDOW_DAYS = 3;
const SUMMARY_MAX_CHARS = 100;
const TRANSLATE_BATCH = 10;

const ALL_SOURCES: SourceId[] = [
  "xinhua",
  "people",
  "sina",
  "hackernews",
  "bbc",
  "guardian",
  "techcrunch",
];

function nowIso(): string {
  return new Date().toISOString();
}

function isStale(db: Database.Database, source: SourceId, ttlMs: number): boolean {
  const row = db
    .prepare(`SELECT MAX(fetched_at) AS latest FROM news_items WHERE source = ?`)
    .get(source) as { latest: string | null };
  if (!row?.latest) return true;
  return Date.now() - new Date(row.latest.replace(" ", "T") + "Z").getTime() > ttlMs;
}

function upsert(db: Database.Database, source: SourceId, raw: RawItem): void {
  db.prepare(
    `INSERT INTO news_items (source, external_id, title, url, published_at, heat_score, fetched_at, description)
     VALUES (@source, @external_id, @title, @url, @published_at, @heat_score, @fetched_at, @description)
     ON CONFLICT(source, external_id) DO UPDATE SET
       title = excluded.title,
       url = excluded.url,
       published_at = COALESCE(excluded.published_at, news_items.published_at),
       heat_score = excluded.heat_score,
       fetched_at = excluded.fetched_at,
       description = COALESCE(excluded.description, news_items.description)`,
  ).run({
    source,
    external_id: raw.external_id,
    title: raw.title,
    url: raw.url,
    published_at: raw.published_at,
    heat_score: raw.heat_score,
    fetched_at: nowIso(),
    description: raw.description ?? null,
  });
  if (getFts5EnabledSafe(db)) {
    const row = db
      .prepare(`SELECT id FROM news_items WHERE source=? AND external_id=?`)
      .get(source, raw.external_id) as { id: number } | undefined;
    if (row) {
      // I2：REPLACE 时保留已翻译的 title_zh（刷新不抹除中文索引）
      db.prepare(
        `INSERT OR REPLACE INTO news_fts(rowid, title, title_zh)
         VALUES (?, ?, COALESCE((SELECT title_zh FROM news_items WHERE id = ?), NULL))`,
      ).run(row.id, raw.title, row.id);
    }
  }
}

function getFts5EnabledSafe(db: Database.Database): boolean {
  try {
    db.prepare(`SELECT rowid FROM news_fts LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function updateFtsZh(db: Database.Database, id: number, titleZh: string | null): void {
  try {
    db.prepare(`UPDATE news_fts SET title_zh = ? WHERE rowid = ?`).run(titleZh, id);
  } catch {
    // FTS 不可用：忽略
  }
}

export interface NewsServiceDeps {
  db: Database.Database;
  fetchers: Record<SourceId, NewsFetcher>;
  llm?: LLMClient;
  fts5Enabled?: boolean;
  articleFetch?: typeof fetch;
  ttlMs?: number;
}

/** 新闻按需服务：不问不查（无定时任务），查询触发刷新。 */
export function createNewsService(deps: NewsServiceDeps) {
  const { db, fetchers, llm } = deps;
  const ttlMs = deps.ttlMs ?? TTL_MINUTES * 60_000;
  const fts5 = () => deps.fts5Enabled ?? isFts5Enabled();

  async function extractArticleText(url: string, fallbackDescription: string | null): Promise<string | null> {
    const doFetch = deps.articleFetch ?? fetch;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(6000) } as RequestInit);
      if (!res.ok) throw new Error(`article ${res.status}`);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const article = new Readability(doc).parse();
      const text = article?.textContent?.trim();
      if (text && text.length > 40) return text.slice(0, 4000);
    } catch {
      // 抽取失败：降级
    }
    return fallbackDescription ?? null;
  }

  async function translateAndSummarize(items: NewsItem[]): Promise<void> {
    if (!llm) return;
    const foreign = items.filter(
      (i) =>
        FOREIGN_SOURCES.includes(i.source) && (i.title_zh === null || i.summary_zh === null),
    );
    if (foreign.length === 0) return;
    const batch = foreign.slice(0, TRANSLATE_BATCH);

    const materials: { external_id: string; title: string; text: string | null }[] = [];
    for (const it of batch) {
      const row = db
        .prepare(`SELECT description FROM news_items WHERE id = ?`)
        .get(it.id) as { description: string | null } | undefined;
      const text = await extractArticleText(it.url, row?.description ?? null);
      materials.push({ external_id: it.external_id, title: it.title, text });
    }

    // 构建 prompt
    const system = `你是新闻编辑。对输入的每条外文新闻输出中文译题 title_zh 与不超过100字的中文摘要 summary_zh。
只输出 JSON 数组，每项 {"external_id": "...", "title_zh": "...", "summary_zh": "..."}，不要任何其他文字。正文缺失时 summary_zh 用 null。`;
    const user = JSON.stringify(materials);

    try {
      let out = "";
      for await (const delta of llm.stream({ system, messages: [{ role: "user", content: user }], tools: [] })) {
        if (delta.type === "text") out += delta.delta;
      }
      const start = out.indexOf("[");
      const end = out.lastIndexOf("]");
      const parsed = JSON.parse(out.slice(start, end + 1)) as {
        external_id: string;
        title_zh: string | null;
        summary_zh: string | null;
      }[];
      const update = db.prepare(
        `UPDATE news_items SET title_zh = COALESCE(?, title_zh), summary_zh = COALESCE(?, summary_zh) WHERE source = ? AND external_id = ?`,
      );
      for (const r of parsed) {
        const summary =
          typeof r.summary_zh === "string"
            ? Array.from(r.summary_zh).slice(0, SUMMARY_MAX_CHARS).join("")
            : null;
        const item = batch.find((b) => b.external_id === r.external_id);
        update.run(r.title_zh ?? null, summary, item?.source ?? "", r.external_id);
        if (item) {
          updateFtsZh(db, item.id, r.title_zh ?? null);
          item.title_zh = r.title_zh ?? item.title_zh;
          item.summary_zh = summary ?? item.summary_zh;
        }
      }
    } catch {
      // 摘要失败：不阻塞搜索结果
    }
  }

  async function searchNews(q: SearchNewsQuery): Promise<NewsSearchResult> {
    const sources = q.source ? [q.source] : ALL_SOURCES;
    const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const historical = Boolean(q.from && q.from < cutoff);

    const skippedSources: SourceId[] = [];
    const failedSources: SourceId[] = [];
    const targets: SourceId[] = [];
    for (const s of sources) {
      const fetcher = fetchers[s];
      if (!fetcher) continue;
      if (historical && !fetcher.supportsRange) {
        skippedSources.push(s);
        continue;
      }
      targets.push(s);
    }

    if (targets.length === 0) {
      return { items: [], dataTime: nowIso(), skippedSources, unsupported: true, failedSources };
    }

    // 按需抓取：历史区间现抓；近期缓存过期才抓（失败用旧缓存）
    await Promise.all(
      targets.map(async (s) => {
        const fetcher = fetchers[s];
        try {
          if (historical && fetcher.fetchRange && q.from && q.to) {
            const raws = await fetcher.fetchRange(q.from, q.to);
            for (const raw of raws) upsert(db, s, raw);
            logRun(db, s, "ok", raws.length);
          } else if (!historical && (!q.from || q.from >= cutoff) && isStale(db, s, ttlMs)) {
            const raws = await fetcher.fetchLatest();
            for (const raw of raws) upsert(db, s, raw);
            logRun(db, s, "ok", raws.length);
          }
        } catch (err) {
          failedSources.push(s);
          logRun(db, s, "error", 0, err instanceof Error ? err.message : String(err));
        }
      }),
    );

    // 检索（keyword 模式同样应用日期区间，I3）
    // Ruling: 关键词检索一律 LIKE——unicode61 把 CJK+拉丁混排标题切成整 token，
    // MATCH 'AI' 命中不了"上周的AI新闻"；子串语义对中文正确，个人数据量 LIKE 足够。
    const limit = Math.min(q.limit ?? 20, 50);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const fromOk = q.from && DATE_RE.test(q.from) ? q.from : null;
    const toOk = q.to && DATE_RE.test(q.to) ? q.to : null;
    const dateFilterSql = fromOk
      ? toOk
        ? ` AND (published_at IS NULL OR substr(published_at, 1, 10) BETWEEN '${fromOk}' AND '${toOk}')`
        : ` AND (published_at IS NULL OR substr(published_at, 1, 10) >= '${fromOk}')`
      : "";
    let rows: NewsItem[];
    if (q.mode === "keyword" && q.keywords.length > 0) {
      const kws = q.keywords.map((k) => k.replace(/[%_]/g, "").trim()).filter(Boolean);
      const conds = kws.map(() => `(title LIKE ? OR title_zh LIKE ?)`).join(" OR ");
      const params: unknown[] = [];
      for (const k of kws) params.push(`%${k}%`, `%${k}%`);
      let sql = `SELECT * FROM news_items WHERE (${conds})`;
      if (q.source) {
        sql += ` AND source = ?`;
        params.push(q.source);
      }
      sql += `${dateFilterSql} ORDER BY published_at DESC LIMIT ?`;
      params.push(limit);
      rows = db.prepare(sql).all(...params) as NewsItem[];
    } else {
      let sql = `SELECT * FROM news_items`;
      const params: unknown[] = [];
      if (q.source) {
        sql += ` WHERE source = ?`;
        params.push(q.source);
      }
      if (q.from) {
        sql += q.source ? ` AND` : ` WHERE`;
        sql += ` substr(published_at, 1, 10) BETWEEN ? AND ?`;
        params.push(q.from, q.to ?? new Date().toISOString().slice(0, 10));
      }
      sql += ` ORDER BY heat_score DESC, published_at DESC LIMIT ?`;
      params.push(limit);
      rows = db.prepare(sql).all(...params) as NewsItem[];
    }

    const items = rows.map((r) => ({ ...r }));
    await translateAndSummarize(items);

    const dataTimeRow = db
      .prepare(`SELECT MAX(fetched_at) AS t FROM news_items`)
      .get() as { t: string | null };

    return {
      items,
      dataTime: dataTimeRow?.t ?? nowIso(),
      skippedSources,
      failedSources,
    };
  }

  function sourcesHealth(): { source: string; status: string; last_run: string | null; items: number }[] {
    return ALL_SOURCES.map((s) => {
      const run = db
        .prepare(`SELECT status, started_at FROM news_fetch_runs WHERE source = ? ORDER BY id DESC LIMIT 1`)
        .get(s) as { status: string; started_at: string } | undefined;
      const count = (
        db.prepare(`SELECT COUNT(*) AS n FROM news_items WHERE source = ?`).get(s) as { n: number }
      ).n;
      return {
        source: s,
        status: run?.status ?? "idle",
        last_run: run?.started_at ?? null,
        items: count,
      };
    });
  }

  return { searchNews, sourcesHealth };
}

function logRun(db: Database.Database, source: string, status: "ok" | "error", count: number, error?: string): void {
  db.prepare(
    `INSERT INTO news_fetch_runs (source, status, item_count, error, finished_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(source, status, count, error ?? null);
}
