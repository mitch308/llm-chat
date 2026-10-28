# news —— 新闻业务

新闻检索的按需抓取闭环：关键词搜索 / 热点浏览 / 指定来源，外文来源经 LLM 做中文译题与摘要。无定时任务，查询时才抓取（30 分钟 TTL 缓存）。

## 目录结构

| 路径 | 职责 |
|---|---|
| `shared.ts` | 两端单一契约源：`NEWS_COMPONENTS` 清单 + `NewsList` / `NewsItem` 的 props zod |
| `server/index.ts` | `defineServerFeature("news", …)` 入口：注册 DDL / `news_fts`（可选）/ catalog / 技能 prompt / 工具 / 路由 |
| `server/sources.ts` | 来源契约：`SourceId`（新华社/人民网/新浪/HN/BBC/Guardian/TechCrunch）、`RawItem`、`NewsFetcher` 接口、`FETCH_TIMEOUT_MS`（8s）、`heatFromRank` |
| `server/fetchers.ts` | `buildSourceFetchers()`（可注入 `FetchImpl`）与 `SOURCE_IDS` |
| `server/fetchers/` | 各来源实现：`rss.ts`（RSS 通用）、`hn.ts`、`guardian.ts` + `fetchers.test.ts` |
| `server/news.service.ts` | `createNewsService({ db, llm, fetchers })`：按需抓取、去重落库、热度、**LIKE 关键词检索**、LLM 译题摘要（`translateAndSummarize`） |
| `server/news.routes.ts` | REST：`GET /api/news/search`、`GET /api/news/sources`（llm 由路由工厂透传，供 REST 路径翻译） |
| `server/tools.ts` | Agent 工具 `search_news`（keywords 数组 + mode keyword/hot + source/from/to/limit） |
| `web/index.ts` | `defineWebFeature("news", …)` 入口 |
| `web/NewsList.vue` / `web/NewsItem.vue` | 列表（中文译题为主、原题与原文链接必带、`dataTime` 注明数据时间）/ 单条 |

## 注册贡献物一览（`server/index.ts`）

`ctx.ddl`（`news_items` + 索引 + `news_fetch_runs`）→ `ctx.ddlOptional(DDL_FTS)`（FTS5 不可用即降级，检索路径不受影响）→ `ctx.catalogComponents` → `ctx.skill`（新闻技能段）→ `ctx.tool(search_news)` → `ctx.route((db, llm) => newsRoutes(db, llm))`。

## 关键约束（改动前必读）

- 关键词检索刻意用 **LIKE，不用 FTS MATCH**：FTS5 unicode61 把 CJK+拉丁混排标题切成单一 token，`MATCH 'AI'` 命中不了。要换先上 trigram 分词器并重写测试。
- 按源降级是设计行为：BBC 直连与公共 RSSHub 在当前网络不可达为已知状态；自托管 RSSHub 后设 `RSSHUB_BASE`。来源失败/不支持时在结果里降级说明，不阻塞其余来源。
- 历史日期区间仅 Hacker News 与 The Guardian 支持（`supportsRange`），其余来源仅近期（约 3-7 天）。
- 单来源抓取超时 8 秒；条目缓存 TTL 30 分钟；无热度数据时按排名合成 0-100。

## 测试

`server/news.service.test.ts`（检索/缓存/降级/翻译，全 fake 注入）、`server/fetchers/fetchers.test.ts`（各来源解析）、`server/news.routes.test.ts`（REST 路径翻译全链路，app 级 supertest，无网络）。

## 增删本 feature

通用流程见 [AGENTS.md「features 架构」](../../AGENTS.md) 与 [features 架构 spec](../../docs/superpowers/specs/2026-10-28-features-architecture.md)。删除时同步清理 `features/kernel/consistency.test.ts` 与 `web/src/render/registry.test.ts` 里对 `NEWS_COMPONENTS` 的并集断言引用。
