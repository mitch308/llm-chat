import { z } from "zod";
import type { ToolEntry } from "@llm-chat/features/server";
import { buildSourceFetchers } from "./fetchers";
import { createNewsService } from "./news.service";
import type { SourceId } from "./sources";

/** search_news 入参 schema（自原 server/src/agent/agent.ts argSchemas 逐字迁移）。 */
const searchNewsArgs = z
  .object({
    keywords: z.array(z.string()).optional(),
    mode: z.enum(["keyword", "hot"]).optional(),
    source: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().optional(),
  })
  .strict();

/** 新闻搜索工具（def 自原 server/src/agent/tools.ts、执行体自 agent.ts case 逐字迁移；
 *  每次调用现建真实服务，检索服务经由 env 注入 db/llm）。 */
export const searchNewsTool: ToolEntry = {
  def: {
    type: "function",
    function: {
      name: "search_news",
      description:
        "搜索新闻（按需抓取）。keywords 传入联想扩展后的多个词；mode=hot 为热点榜；source 指定来源；from/to 仅 Hacker News 与 The Guardian 支持历史区间",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "关键词数组（含扩展词），关键词模式必填",
          },
          mode: { type: "string", enum: ["keyword", "hot"] },
          source: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
  },
  schema: searchNewsArgs,
  async execute(args, env) {
    const n = args as z.infer<typeof searchNewsArgs>;
    const keywords = n.keywords ?? [];
    const mode = n.mode === "hot" ? "hot" : keywords.length > 0 ? "keyword" : "hot";
    try {
      const result = await createNewsService({
        db: env.db,
        llm: env.llm,
        fetchers: buildSourceFetchers(),
      }).searchNews({
        keywords,
        mode,
        source: n.source as SourceId | undefined,
        from: n.from,
        to: n.to,
        limit: n.limit,
      });
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "新闻查询失败",
      });
    }
  },
};
