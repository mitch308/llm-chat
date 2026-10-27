# AGENTS.md

pnpm monorepo：`server/`（Node+TS 单服务：REST API + AGENT 运行时 + SQLite）+ `web/`（Vue3+TS 聊天界面）。中文优先的个人助理产品（记账 + 新闻），文档与提示词均为中文。

## 命令

```bash
pnpm install
pnpm dev            # 并行起 server(127.0.0.1:8787) + web(vite 5173，/api 代理到 8787)
pnpm -r test        # 全部测试（server 85 + web 31，全部无网络、无真实 API key）

# 单包 / 单文件（必须进包目录或用 --filter；根目录没有 vitest）
cd server && npx vitest run src/ops/ops.test.ts
cd web && npx vitest run src/chat/useChat.test.ts
pnpm --filter @llm-chat/server test
```

## 环境与 Windows 坑

- LLM 配置在 `server/.env`（模板 `.env.example`）：`ZHIPU_API_KEY` / `ZHIPU_MODEL`（默认 glm-5.3-flash）/ `ZHIPU_BASE_URL`。**`.env` 只在 `server/src/index.ts` 启动时 `process.loadEnvFile()` 加载——测试里不生效**，测试一律注入 fake（`createFakeLLM(script: Delta[][])`，惰性脚本模式见 `agent.test.ts`）。
- pnpm v10 拦截原生模块编译：`onlyBuiltDependencies` 必须放**根** package.json（放子包不生效）。
- 测试里临时 SQLite 必须先 `closeAllForTests()` 再 `rmSync`，否则 Windows EBUSY。
- Vite dev 绑的是 localhost（IPv6）——用 `http://localhost:5173` 验证代理，`127.0.0.1:5173` 会拒连。
- 清理占用端口：`netstat -ano | grep :8787` 找 PID 后 `taskkill //PID <pid> //F`。

## 架构关键点（文件名看不出来的）

- **依赖注入贯穿**：`createApp({db, llm})`（`server/src/app.ts`）；fetchers/articleFetch/fts5Enabled/ttlMs/now 全部可注入。新增功能保持这个模式，别在测试里碰真网络。
- **json-render 的 catalog 只在服务端**（`server/src/agent/catalog.ts`，供 `catalog.prompt()` 生成系统提示词）；web 端只有 `web/src/render/registry.ts` 的 类型→组件 映射。**不要在 web 复制 catalog 定义**；两边组件名/props 必须逐字一致。`@json-render/vue` 的 `schema` 导出在纯 Node 引入是安全的。
- **SSE 协议**：服务端做文字/JSONL 分离（`chat/streamSplitter.ts`，内部事件用 `{kind}`），对前端事件是 `{"type":"text"|"spec"|"tool"|"done"|"error"}`。历史消息的 spec 以 JSONL 行数组存 `messages.spec_json`。
- **写操作必须走提议生命周期**（`ops/ops.service.ts`）：服务端发 op_id、全局最多 1 个 pending、TTL 10 分钟、executed 幂等重放。动作路由有 kind 一致性守卫（`POST /api/actions/:name` 的 name 必须等于提议的 kind，否则 409 OP_KIND_MISMATCH）——别绕过。
- **新闻关键词检索刻意用 LIKE，不用 FTS MATCH**：FTS5 unicode61 把 CJK+拉丁混排标题（"上周的AI新闻"）切成单一 token，`MATCH 'AI'` 命中不了。`news_fts` 表存在但检索路径不用它；要换就上 trigram 分词器并重写测试。
- 账单金额库内一律 `amount_cents` 整数；类目两级（`db/seeds.ts`），bills 必须挂**叶子**类目；父类名查询在 `bills.service.ts` 展开为全部子类。
- DB 无迁移系统：`db/schema.ts` 是 `CREATE TABLE IF NOT EXISTS` 顺序执行。改列 = 改 DDL + 删 `server/data/llm-chat.db` 重建（开发期可接受）。
- 中文输入法：`ChatInput.vue` 的 Enter 有 `isComposing/keyCode 229` 守卫，改动输入逻辑时别丢。

## 文档优先级

需求以 `docs/superpowers/specs/2026-10-27-llm-chat-design.md` 为权威（与代码冲突以 spec 为准并回改）；`README.md` 有验收清单（标注了哪些待真实 API key 手测）与新增 SKILL 的四步指南。新闻源连通性：BBC 直连与公共 RSSHub 在当前网络不可达是已知状态（按源降级），自托管 RSSHub 后设 `RSSHUB_BASE`。
