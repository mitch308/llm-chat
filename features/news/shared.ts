import { z } from "zod";

/** news 组件清单（web 注册见 features/news/web/index.ts，与本清单一一对应）；Props zod 自原 server/src/agent/catalog.ts 逐字迁移。 */
export const NEWS_COMPONENTS = ["NewsList", "NewsItem"] as const;

export const NewsListProps = z.object({
  items: z.array(
    z.object({
      title_zh: z.string().nullable(),
      title: z.string(),
      summary_zh: z.string().nullable(),
      source: z.string(),
      heat: z.number(),
      published_at: z.string().nullable(),
      url: z.string(),
    }),
  ),
  dataTime: z.string().nullable(),
});

export const NewsItemProps = z.object({
  title_zh: z.string().nullable(),
  title: z.string(),
  summary_zh: z.string().nullable(),
  source: z.string(),
  heat: z.number(),
  published_at: z.string().nullable(),
  url: z.string(),
});
