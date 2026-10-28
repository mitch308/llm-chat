import { defineServerFeature } from "@llm-chat/features/server";
import { NEWS_COMPONENTS, NewsItemProps, NewsListProps } from "../shared";

/**
 * 新闻技能 body：原 server/src/agent/prompts.ts 的「# 新闻技能」段逐字迁移。
 */
const NEWS_SKILL_BODY = `# 新闻技能

1. 识别模式：关键词搜索 / 热点浏览("看热点/热点新闻") / 指定来源
2. 没有主题且未明确要热点榜 → 纯文字追问："想了解哪方面的新闻？也可以直接说'看热点'"
3. 关键词联想扩展：先在回复前就地扩展同义词（AI→AI、人工智能、LLM、大模型），把扩展词一起传给 search_news(keywords)
4. 调 search_news(keywords/mode/source/from/to) → 渲染 NewsList（items 含译题/摘要/原题/来源/热度/时间/链接；dataTime 注明数据时间）
5. 空结果 → 文字建议换关键词或看热点榜；某来源不可用 → 文字说明并展示其余来源
6. 历史区间：只有 Hacker News 和 The Guardian 支持历史日期查询，其余仅近期（约3-7天）。超出支持范围的来源会被跳过并在回答中注明；全部不支持 → 回复不支持该时间范围并说明各来源支持范围`;

/** news feature：数据层（DDL/FTS 降级）+ 组件目录 + 新闻技能提示词。 */
export default defineServerFeature("news", (ctx) => {
  ctx.ddl([
    `CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_zh TEXT,
    summary_zh TEXT,
    url TEXT NOT NULL,
    published_at TEXT,
    heat_score INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT,
    UNIQUE(source, external_id)
  )`,
    `CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at)`,

    `CREATE TABLE IF NOT EXISTS news_fetch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','error')),
    item_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`,
  ]);
  // FTS5 可用时建全文索引虚拟表（独立内容，rowid 对应 news_items.id）；不可用则跳过（检索降级 LIKE）。
  ctx.ddlOptional(
    `CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(title, title_zh)`,
  );

  // 组件 zod 自原 server/src/agent/catalog.ts 逐字迁移（经 shared.ts 单一来源）
  ctx.catalogComponents({
    [NEWS_COMPONENTS[0]]: {
      props: NewsListProps,
      description: "新闻列表：中文译题/摘要为主，原题与原文链接必带；dataTime 注明数据时间",
    },
    [NEWS_COMPONENTS[1]]: {
      props: NewsItemProps,
      description: "单条新闻",
    },
  });
  ctx.skill({
    intent: "新闻意图（关键词搜索/热点浏览/指定来源）",
    label: "新闻技能",
    hint: "📰新闻（关键词搜索/热点浏览）",
    body: NEWS_SKILL_BODY,
  });
});
