# Features 目录重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增根目录 `features/` 工作区包，把记账/新闻业务的前后端代码（路由、工具、catalog、技能 prompt、DDL/种子、组件）收拢进各自的 feature 目录，通过 server/web 两个注册上下文自动扫描装配，实现"增删业务 = 增删文件夹"。

**Architecture:** 插件贡献制。`features/kernel/server.ts` 定义 `ServerFeatureContext`（ddl/ddlOptional/seed/route/tool/catalog/skill/ops 注册口）与扫描组装器（Node 侧 `fs.readdir` + 动态 import）；`features/kernel/web.ts` 定义 `WebFeatureContext` 与 registry 组装器（Vite 侧 `import.meta.glob`）。server 的 `src/features.ts` 用 top-level await 产出全局装配 `ASM`，connection/app/agent/prompts 全部从 `ASM` 取业务贡献；web 的 `registry.ts` 用 TLA 从 glob 组装。ops 提议生命周期、chat 管线、messages、SSE 协议保持核心不变，ops 执行器改为按 feature 注册的 `OpHandler` 分发。

**Tech Stack:** pnpm workspace（新增 `@llm-chat/features` 包，TS 源码直引无构建）、Express 5 Router、zod 4、@json-render/core|vue、Vite 6 / vitest 3、better-sqlite3。

**Spec:** `docs/superpowers/specs/2026-10-27-llm-chat-design.md`（行为不变的重构；§9.3 组件目录等文件位置描述由本计划更新，见 Task 9）。设计决策记录在本文档头部与各任务 "Interfaces"。

## Global Constraints（来自 AGENTS.md，逐条适用所有任务）

- 测试一律无网络：LLM 用 `createFakeLLM(script)`，新闻 fetcher 注入 fake；绝不碰真实 API key。
- 临时 SQLite 测试结束必须先 `closeAllForTests()` 再 `rmSync`（Windows EBUSY）。
- 测试运行必须进包目录：`cd server && npx vitest run <file>`；根目录没有 vitest。
- 新闻检索保持 LIKE，不引入 FTS MATCH。
- 账单金额库内一律 `amount_cents` 整数；bills 必须挂叶子类目。
- `ChatInput.vue` 的 Enter `isComposing/keyCode 229` 守卫不得改动。
- SSE 事件协议 `{"type":"text"|"spec"|"tool"|"done"|"error"}` 不变。
- ops 生命周期语义不变：服务端发号、全局最多 1 个 pending、TTL 10 分钟、executed 幂等重放、动作 kind 一致性守卫（OP_KIND_MISMATCH）。
- catalog 组件名与 web 组件名/props 一致：由 `features/*/shared.ts` 单一来源 + 两侧测试保证（替代原"人工逐字一致"约定）。
- 文档与提示词中文；提交信息用 `feat:`/`refactor:`/`test:`/`docs:` 前缀 + 中文描述。
- 每个任务结束：该包 vitest 全绿 + `pnpm -r test` 全绿后才 commit。

## Review Focus（规格隐含但无单测直接覆盖的失效模式，最易咬人）

1. **删除某 feature 目录后的残留**：server 必须照常启动，技能路由表与"暂不支持该功能，目前支持：…"话术自动收缩到剩余 feature。→ Task 1 `composeSkillsPrompt` 测试 pin：单个 skill 时路由表为"2 类结果"、hints 正确拼接。
2. **前后端组件清单漂移**（spec 引用了未注册/已删组件类型）：web `registry` 键集合必须恒等于三个 `shared.ts` 类型清单的并集，server catalog 同。→ Task 6a（server 侧）与 Task 8（web 侧）各一个一致性测试。
3. **模型幻觉出未注册的 op kind**：`propose_op` 收到未知 kind 必须回喂 `{ok:false}` 而非崩溃/落库。→ Task 7 agent 测试。
4. **两个 feature 撞名**（同名组件/工具/路由重复注册）：组装必须 fail-fast 抛错，不允许静默覆盖。→ Task 1 组装测试。
5. **旧库带 `op_proposals.kind` CHECK 约束**：移除 CHECK 后旧开发库插入新 kind 会失败，必须提示 `pnpm db:rebuild`。→ Task 7 文档步骤（README 已有重建说明，追加一行触发原因）。

---

### Task 1: features 工作区包 + server kernel（上下文/组装/扫描）

**Files:**
- Create: `features/package.json`
- Create: `features/kernel/server.ts`
- Create: `features/kernel/__fixtures__/demo/server/index.ts`（扫描测试夹具）
- Create: `features/kernel/server.test.ts`
- Modify: `pnpm-workspace.yaml`（packages 加 `features`）
- Modify: `server/package.json`（dependencies 加 `"@llm-chat/features": "workspace:*"`）
- Modify: `server/vitest.config.ts`（include 加 kernel 测试）
- Create: `features/tsconfig.json`

**Interfaces（后续所有任务消费，逐字实现）:**

```ts
// features/kernel/server.ts
import type Database from "better-sqlite3";
import type { Router } from "express";
import type { ZodType } from "zod";

// ---- 与 server/src/chat/llm.ts 结构一致的 wire 类型（kernel 为唯一权威，llm.ts 改为 re-export）----
export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolDef { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ModelMsg { role: "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
export type Delta = { type: "text"; delta: string } | { type: "tool_calls"; calls: ToolCall[] };
export interface LLMClient { stream(input: { system: string; messages: ModelMsg[]; tools: ToolDef[] }): AsyncIterable<Delta> }

export type RunResult = { ok: true; data: object } | { ok: false; code: string; message: string };
export interface ToolEnv { db: Database.Database; llm?: LLMClient }
export interface ToolEntry {
  def: ToolDef;
  schema?: ZodType;                       // agent 入参校验（原 argSchemas 各业务段）
  execute(args: unknown, env: ToolEnv): Promise<unknown>;
}
export interface OpHandler {
  argPayload: ZodType;                    // propose_op 的 payload 校验（按 kind 查）
  execute(payload: Record<string, unknown>, env: ToolEnv): Promise<RunResult> | RunResult;
  afterExecute?(env: ToolEnv & { opId: string }, data: object): void;  // 写结果 + quip 等后置
  cardHint?: string;                      // propose_op 成功后回喂的 spec 卡片指令
}
export interface CatalogComponentDef { props: ZodType; description: string }
export interface CatalogActionDef { params: ZodType; description: string }
export interface SkillSection { intent: string; label: string; hint: string; body: string }

export interface ServerFeatureContext {
  ddl(stmt: string | string[]): void;
  ddlOptional(stmt: string): void;        // 执行失败仅记录（FTS5 降级）
  seed(run: (db: Database.Database) => void): void;
  route(router: Router): void;
  tool(def: ToolDef, opts: { schema?: ZodType; execute(args: unknown, env: ToolEnv): Promise<unknown> }): void;
  catalogComponents(defs: Record<string, CatalogComponentDef>): void;
  catalogActions(defs: Record<string, CatalogActionDef>): void;
  skill(section: SkillSection): void;
  ops(kinds: string[], handler: OpHandler): void;
}
export interface ServerFeature { name: string; register(ctx: ServerFeatureContext): void }
export interface AssembledServer {
  ddl: string[]; ddlOptional: string[];
  seedFns: ((db: Database.Database) => void)[];
  routers: Router[];
  tools: Map<string, ToolEntry>;
  catalog: ReturnType<typeof defineCatalog>;   // defineCatalog(schema, {components, actions}) 的合并结果
  skills: SkillSection[];
  ops: Map<string, OpHandler>;
}
export function defineServerFeature(name: string, register: (ctx: ServerFeatureContext) => void): ServerFeature;
export function assembleServerFeatures(features: ServerFeature[]): AssembledServer;
export async function scanServerFeatures(dirUrl: URL): Promise<ServerFeature[]>;
// 读取/写入 op_proposals.result_json（{data, quip} 形状，替代原 ops.executor.storeResult）
export function readOpResult(db: Database.Database, opId: string): { data?: object; quip?: string | null };
export function writeOpResult(db: Database.Database, opId: string, data: object, quip: string | null): void;
// FTS5 旗标（原 db/connection.ts 模块态，news.service 消费）
export function isFts5Enabled(): boolean;
export function setFts5Enabled(v: boolean): void;
```

组装语义（写进实现）：
- `assembleServerFeatures` 按传入顺序调用各 feature 的 `register`；`tools`/`ops`/catalog components/actions **键冲突抛 `Error`**（fail-fast，Review Focus 4）。
- catalog 合并时 kernel 内置一条核心 action：`cancel_op: { params: z.object({ op_id: z.string() }), description: "取消当前提议" }`（ops 是核心设施，不属任何 feature）。
- `scanServerFeatures`：`readdirSync(dirUrl, {withFileTypes:true})` 过滤目录且存在 `server/index.ts`，按目录名 `.sort()` 后逐个 `await import(pathToFileURL(join).href)`，取 `mod.default`。顺序确定性是 DDL/技能顺序的保证。

- [ ] **Step 1: 写失败测试** `features/kernel/server.test.ts`：
  - `defineServerFeature` + `assembleServerFeatures`（内联两个 feature A/B）：断言 `ddl` 收集顺序 = 注册顺序；同名 tool 注册两个 feature 时 `expect(() => assemble…).toThrow()`；catalog 含内置 `cancel_op`；`ops` 按 kind 可查。
  - `scanServerFeatures(new URL("./__fixtures__/", import.meta.url))` 返回 1 个名为 `demo` 的 feature（夹具 `defineServerFeature("demo", ctx => ctx.ddl("SELECT 1"))`，夹具文件相对路径 `../../../server` 引 kernel）。
- [ ] **Step 2: 跑测试确认失败**：`cd server && npx vitest run --root .. ../features/kernel/server.test.ts`（此步允许用临时方式；Task 3 改完 include 后常规命令生效）。Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现** `features/package.json`（`name: "@llm-chat/features"`, `private`, `type: "module"`, `exports: {"./server": "./kernel/server.ts", "./web": "./kernel/web.ts"}`；dependencies: `zod ^4.6.7`、`@json-render/core ^0.21.3`、`@json-render/vue ^0.21.3`、`express ^5.3.0`、`rss-parser ^3.13.0`、`@mozilla/readability ^0.6.0`、`linkedom ^0.18.14`、`vue ^3.5.0`；devDependencies: `typescript`、`@types/better-sqlite3`、`@types/express`、`@types/node`）与 `kernel/server.ts`。`pnpm-workspace.yaml` 加 `- features`；`server/package.json` 加依赖；`server/vitest.config.ts` include 改为 `["src/**/*.test.ts", "../features/*/server/**/*.test.ts", "../features/kernel/*.test.ts"]`；`features/tsconfig.json`（target ES2022、module ESNext、moduleResolution Bundler、strict、lib ["ES2022","DOM","DOM.Iterable"]、types ["node"]、noEmit、include ["**/*.ts","**/*.vue"]）。
- [ ] **Step 4: `pnpm install` 后跑测试通过**：`cd server && npx vitest run ../features/kernel/server.test.ts`。Expected: PASS。
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: 新增 features 工作区包与 server kernel（上下文/组装/扫描）"`

### Task 2: web kernel（上下文 + registry 组装器）

**Files:**
- Create: `features/kernel/web.ts`
- Test: 由 Task 8 的 `web/src/render/registry.test.ts` 覆盖（本任务用类型检查 + web 侧冒烟验证即可，不单独建测试文件——kernel/web 的行为测试放在真实 glob 场景下才有意义）。

**Interfaces:**

```ts
// features/kernel/web.ts
import { defineAsyncComponent, type Component } from "vue";
import { defineRegistry } from "@json-render/vue";
export type LazyComponent = () => Promise<{ default: Component }>;
export interface WebFeatureContext { component(type: string, comp: Component | LazyComponent): void }
export interface WebFeature { name: string; register(ctx: WebFeatureContext): void }
export function defineWebFeature(name: string, register: (ctx: WebFeatureContext) => void): WebFeature;
/** modules: import.meta.glob 的产物。按路径排序注册；"Component | Lazy" 中函数形式包 defineAsyncComponent。
 *  返回 defineRegistry({ data: {} } as never, { components }).registry as Record<string, Component>。
 *  注意：异步函数所以调用方需 top-level await。 */
export async function assembleWebRegistry(modules: Record<string, () => Promise<unknown>>): Promise<Record<string, Component>>;
```

- [ ] **Step 1: 实现** `features/kernel/web.ts`（键冲突同样抛错；排除路径含 `/kernel/` 的模块以防自吸）。
- [ ] **Step 2: 验证编译**：`cd web && npx vue-tsc --noEmit 2>/dev/null || npx tsc --noEmit`（web 的 include 尚未含 features，允许无输出即过；Task 3 收口）。Expected: 无新增错误。
- [ ] **Step 3: Commit** `git commit -am "feat: web kernel（WebFeatureContext + registry 组装器）"`

### Task 3: server 接线（ASM 全局装配 + connection 消费）

**Files:**
- Create: `server/src/features.ts`
- Modify: `server/src/db/connection.ts`（DDL/种子/FTS 改为消费 ASM；`getFts5Enabled` 改为转发 kernel 旗标）
- Modify: `server/src/app.ts`（追加挂载 `ASM.routers`；bills/news 等静态路由本任务暂留）
- Modify: `web/package.json`（dependencies 加 `"@llm-chat/features": "workspace:*"`）
- Modify: `web/tsconfig.json`、`web/vitest.config.ts`（include 加 `"../features/*/web/**/*.test.ts"`，其余不变）
- Test: `server/src/smoke.test.ts` 全绿即验收

**Interfaces:**
- Produces: `server/src/features.ts` → `export const ASM: AssembledServer`（`await scanServerFeatures(new URL("../../features/", import.meta.url))` 的结果；本任务时 features 无业务目录，ASM 为空装配）。

- [ ] **Step 1: 写失败测试**：`server/src/db/db.test.ts` 追加一例——向 `features/` 临时不可行，改为：`expect(ASM.ddl).toEqual([])` 且 `getDb` 后 `user_version` 正常建表（证明空装配不破坏核心 DDL）。放在 `db.test.ts` 顶部 import { ASM }。
- [ ] **Step 2: 跑测试确认失败**：`cd server && npx vitest run src/db/db.test.ts`。Expected: FAIL（`../features` 不存在导出）。
- [ ] **Step 3: 实现**：`server/src/features.ts`（TLA + scan）；`connection.ts`：`db.exec([...DDL, ...ASM.ddl].join(";\n"))`，然后逐条 try/exec `ASM.ddlOptional`，全部成功 `setFts5Enabled(true)` 否则遇首个失败即停并 `setFts5Enabled(false)`，再 `for (const s of ASM.seedFns) s(db)`；`getFts5Enabled` 改为 `return isFts5Enabled()`；`app.ts` 在现有 `app.use` 之后 `for (const r of ASM.routers) app.use("/api", r)`；web 包加依赖 + vitest/tsconfig include。
- [ ] **Step 4: 跑测试通过**：`cd server && npx vitest run src/db/db.test.ts src/smoke.test.ts`，随后 `pnpm -r test`。Expected: 全 PASS。
- [ ] **Step 5: Commit** `git commit -am "refactor: server 接入 ASM 全局装配（空装配等价现状）"`

### Task 4: bills 数据层入 feature（DDL + 种子 + service）

**Files:**
- Create: `features/bills/server/index.ts`（`export default defineServerFeature("bills", (ctx) => { ctx.ddl([...]); ctx.seed(seedCategories); })`，随任务推进逐步追加注册）
- Create: `features/bills/server/bills.service.ts`（自 `server/src/bills/bills.service.ts` **原样搬移**）
- Move: `server/src/bills/bills.test.ts` → `features/bills/server/bills.test.ts`（仅改相对 import）
- Delete: `server/src/bills/bills.service.ts`、`server/src/db/seeds.ts`
- Modify: `server/src/db/schema.ts`（删 categories/bills 三表 + 三个索引的 DDL 项；保留 messages、op_proposals、DDL_FTS——FTS 在 Task 5 移交）
- Modify: `server/src/bills/bills.routes.ts`、`server/src/agent/agent.ts`、`server/src/ops/ops.executor.ts`、`server/src/ops/ops.routes.ts`（import 路径改指 feature：`../../../../features/bills/server/bills.service`，过渡期相对路径，Task 6b 起不再有 server 内引用）
- Modify: `server/src/db/db.test.ts`、`server/src/db/rebuild.test.ts`（如引用 `./seeds` 改为 feature 路径；断言不变——表经 ASM 照建、种子照播）

- [ ] **Step 1: 搬移 + 改引用**（先写 `features/bills/server/index.ts` 的 ddl/seed 注册；DDL 文本从 schema.ts 剪切，categories 必须排在 bills 之前）。
- [ ] **Step 2: 跑测试**：`cd server && npx vitest run ../features/bills/server/bills.test.ts src/db/db.test.ts src/db/rebuild.test.ts`。Expected: PASS（bills.test 原断言不变即证明 ASM DDL 等价）。
- [ ] **Step 3: `pnpm -r test` 全绿。**
- [ ] **Step 4: Commit** `git commit -am "refactor: bills 数据层迁入 features/bills（DDL/种子/service）"`

### Task 5: news 数据层入 feature（DDL + FTS 虚表 + fetchers + service）

**Files:**
- Create: `features/news/server/index.ts`（先只 `ctx.ddl([...news_items, news_fetch_runs])` + `ctx.ddlOptional(DDL_FTS)`）
- Move: `server/src/news/{sources.ts, fetchers.ts, news.service.ts}` → `features/news/server/`；`server/src/news/fetchers/` → `features/news/server/fetchers/`；测试文件同迁（`news.service.test.ts`、`fetchers.test.ts`）
- Modify: `features/news/server/news.service.ts`：`getFts5Enabled` 改从 `@llm-chat/features/server` 导入
- Delete: `server/src/news/`（routes 暂留到 Task 6b：`server/src/news/news.routes.ts` 本任务先改 import 指向 feature）
- Modify: `server/src/db/schema.ts`（删 news 两表与 `DDL_FTS`；connection 中原 DDL_FTS try/exec 段已在 Task 3 被 ddlOptional 机制取代，确认无残留）

- [ ] **Step 1: 搬移 + 改引用**。
- [ ] **Step 2: 跑测试**：`cd server && npx vitest run ../features/news/server/news.service.test.ts ../features/news/server/fetchers/fetchers.test.ts src/db/db.test.ts`。Expected: PASS（含 FTS 不可用降级用例仍绿——旗标语义未变）。
- [ ] **Step 3: `pnpm -r test` 全绿。**
- [ ] **Step 4: Commit** `git commit -am "refactor: news 数据层迁入 features/news（DDL/FTS 降级/fetchers/service）"`

### Task 6a: catalog + 技能 prompt 入 feature，prompts.ts 改为组装

**Files:**
- Create: `features/bills/shared.ts`：`export const BILL_COMPONENTS = ["BillConfirmCard","BillList","BillItem"] as const;` `export const BILL_ACTIONS = ["bill_create","bill_update","bill_delete"] as const;` 以及 `BillConfirmCardProps/BillListProps/BillItemProps` 三个 zod（**从 `server/src/agent/catalog.ts` 第 9-61 行逐字剪切**）
- Create: `features/news/shared.ts`：`NEWS_COMPONENTS = ["NewsList","NewsItem"] as const` + `NewsListProps/NewsItemProps`（catalog.ts 78-106 行）
- Create: `features/shared/shared.ts`：`SHARED_COMPONENTS = ["Metric","StatChart","EmptyState","ErrorState"] as const` + 对应 zod（catalog.ts 62-77、107-117 行）
- Create: `features/bills/server/catalog.ts`（catalogComponents：键用 `BILL_COMPONENTS` 引用 + 共享 4 组件归入 bills？**否**——共享组件由下一条）
- Create: `features/shared/server/index.ts`：`defineServerFeature("shared", ctx => ctx.catalogComponents({ Metric…, StatChart…, EmptyState…, ErrorState… }))`
- Modify: `features/bills/server/index.ts`：追加 `catalogComponents`（Bill* 三件）+ `catalogActions`（bill_create/update/delete，params 原文）+ `skill({ intent: "记账意图（记录/查询/修改/删除账单）", label: "记账技能", hint: "📝记账（记录/查询/修改/删除）", body })`；body = 原 SKILLS_PROMPT 的「# 记账技能——记录/查询统计/修改删除」三段**逐字**，并在最前加原「通用规则」中两条记账专属 bullet（金额支持 元/块/万元…；类目为两级…原文）
- Modify: `features/news/server/index.ts`：追加 `catalogComponents`（News*）+ `skill({ intent: "新闻意图（关键词搜索/热点浏览/指定来源）", label: "新闻技能", hint: "📰新闻（关键词搜索/热点浏览）", body })`，body = 原「# 新闻技能」段逐字
- Delete: `server/src/agent/catalog.ts`
- Modify: `server/src/agent/prompts.ts` 重写：

```ts
import { ASM } from "../features";
import type { SkillSection } from "@llm-chat/features/server";
export function composeSkillsPrompt(skills: SkillSection[]): string {
  // 完整保留原文措辞，仅列表与 hints 由 skills 生成：
  // "# 技能路由\n\n根据用户输入判断意图，只允许以下" + (skills.length+1) + "类结果：\n"
  // + skills.map((s,i)=>`${i+1}. ${s.intent} → 走【${s.label}】`).join("\n") + "\n"
  // + `${skills.length+1}. 其他一切（包括问候、闲聊、订机票等）→ 只回复：\n"暂不支持该功能，目前支持：${hints.join("、")}"\n\n`
  // + 原文「路由优先级：…」段
  // + "# 通用规则\n\n" + 通用 bullets：
  //   关键信息缺失→追问（示例改通用："例如订机票没说目的地"）；日期解析原文；
  //   「需要写库的操作一律先生成确认卡片，禁止直接写库」（去"（记/改/删）"）；待确认提议自动取消原文；工具回合沉默原文
  // + "\n\n" + skills.map(s=>s.body).join("\n\n")
}
export const SKILLS_PROMPT = composeSkillsPrompt(ASM.skills);
export const CATALOG_PROMPT = ASM.catalog.prompt({ mode: "inline" });
```

- Modify: `features/bills/server/index.ts` 的注册顺序注意：目录名排序 bills < news < shared，技能 body 顺序与现 prompt 段落顺序一致（记账在新闻前）——无需额外处理，测试兜底。
- Test: `features/kernel/consistency.test.ts`（server 侧）：`ASM.catalog` 的组件键集合 == 三个 shared 清单并集；动作键集合 == BILL_ACTIONS + ["cancel_op"]。
- Modify: `server/src/agent/prompts.test.ts` 重写：`composeSkillsPrompt` 单测（Review Focus 1：单 skill → “只允许以下2类结果”、fallback 行含该 skill hint；两 skill → 3 类结果、hints 顿号拼接）+ 现 `CATALOG_PROMPT`/`buildContext` 两组用例原样保留（断言不变即证明逐字迁移）。

- [ ] **Step 1: 写失败测试**（consistency.test.ts + prompts.test.ts 新用例）。
- [ ] **Step 2: 跑确认失败**：`cd server && npx vitest run ../features/kernel/consistency.test.ts src/agent/prompts.test.ts`。Expected: FAIL。
- [ ] **Step 3: 实现**（shared.ts → 各 feature catalog/skill 注册 → prompts.ts 重写 → 删 catalog.ts）。
- [ ] **Step 4: 跑测试通过 + `pnpm -r test`。**
- [ ] **Step 5: Commit** `git commit -am "refactor: catalog 与技能 prompt 改为 feature 贡献组装"`

### Task 6b: 工具与路由入 feature，agent 动态分发

**Files:**
- Create: `features/bills/server/tools.ts`：`query_bills`、`bills_stats` 的 ToolDef（自 `server/src/agent/tools.ts` 剪切）+ execute（自 `agent.ts` case "query_bills"/"bills_stats" 剪切，签名 `(args, env) => Promise<unknown>`）+ 各自 zod schema（自 `agent.ts` argSchemas 剪切）
- Create: `features/news/server/tools.ts`：`search_news` 同上（case 301-321 行逻辑 + argSchemas.search_news）
- Modify: `features/bills/server/index.ts` / `features/news/server/index.ts`：`ctx.tool(def, {schema, execute})` 与 `ctx.route(billsRoutes(db注入见下))` —— **route 注意**：路由需要 db，`register(ctx)` 没有 db。改为 `ctx.route(routerFactory: (db: Database) => Router)`？**否**——保持接口简单：`AssembledServer.routers` 存 `(db) => Router` 工厂，`ServerFeatureContext.route(fn: (db: Database.Database) => Router)`，`app.ts` 侧 `for (const f of ASM.routers) app.use("/api", f(db))`。以此为准修改 Task 1 的接口签名（kernel 改一行类型）。
- Move: `server/src/bills/bills.routes.ts` → `features/bills/server/bills.routes.ts`；`server/src/news/news.routes.ts` → `features/news/server/news.routes.ts`
- Delete: `server/src/bills/`、`server/src/news/`、`server/src/agent/tools.ts`
- Modify: `server/src/app.ts`（删 bills/news 静态挂载，只剩 messages/ops/chat + ASM.routers）
- Modify: `server/src/agent/agent.ts`：
  - `opts` 增加 `tools?: Map<string, ToolEntry>`（默认 `ASM.tools`，替代原 `newsSearch?` 注入位——`agent.test.ts` 改传自定义 tools 覆盖 `search_news`，fake 逻辑不变）
  - `argSchemas` 改为函数 `schemaFor(name)`：propose_op/execute_op 内置（propose_op 见 Task 7 前 payload 校验仍用现 argSchemas.propose_op，此处先原样保留），其余查 `ASM.tools.get(name)?.schema`
  - `executeToolInner` 的 switch 收敛为：propose_op/execute_op 保留原 case，default 走 `tools.get(name)`，无则 `{ok:false,error:"未知工具: …"}`
  - `llm.stream({…, tools: TOOL_DEFS})` 改 `[...opts.tools.values()].map(t=>t.def)`

- [ ] **Step 1: 先改 kernel `route` 签名为工厂并更新 Task 1 测试**（一行断言）。
- [ ] **Step 2: 搬移工具/路由 + agent 分发改造 + agent.test.ts 注入点替换**（`newsSearch: fake` → `tools: withSearchNews(fake)`，helper 写在 agent.test.ts 内）。
- [ ] **Step 3: 跑测试**：`cd server && npx vitest run src/agent/agent.test.ts src/chat/chat.text.test.ts src/smoke.test.ts ../features/bills/server ../features/news/server`。Expected: PASS（agent 惰性脚本、假新闻注入、路由 404/400 行为不变）。
- [ ] **Step 4: `pnpm -r test` 全绿。**
- [ ] **Step 5: Commit** `git commit -am "refactor: 工具定义与 REST 路由迁入 feature，agent 改注册表分发"`

### Task 7: ops 泛化（OpHandler 分发 + 执行器/quip 入 bills）

**Files:**
- Modify: `features/kernel/server.ts`：`route` 已在 6b 改工厂；本任务无 kernel 改动（OpHandler/read/writeOpResult 已在 Task 1 定义）
- Create: `features/bills/server/bill-ops.ts`：`runBillAction`、`resolveLeafCategoryId`、`yuanToCents`、`monthRange`（自 `server/src/ops/ops.executor.ts` 剪切）；`OpHandler` 实例：`argPayload`（原 argSchemas.propose_op.payload 的 zod）、`execute: (payload, env) => runBillAction(env.db, kind, payload)`、`afterExecute: ({db, llm, opId}, data) => { writeOpResult(db, opId, data, null); attachQuipInBackground(db, llm, opId, (data as {bill: Bill}).bill); }`、`cardHint`：propose 成功 hint 原文（"提议已创建。立即输出 ```spec …BillConfirmCard…" 两条 hint 文案随分支）
- Create: `features/bills/server/quip.ts`（自 `server/src/ops/quip.ts` 搬移）+ `attachQuip/attachQuipInBackground`（自 ops.executor 剪切）；quip.test.ts 同迁
- Create: `features/bills/server/bill-ops.test.ts`：从 ops.routes.test.ts 抽出的业务断言（VALIDATION 金额/日期/类目、BAD_CATEGORY、bill_delete NOT_FOUND、金额转 cents）——直接调 `runBillAction`
- Modify: `features/bills/server/index.ts`：`ctx.ops(BILL_ACTIONS, handler)`
- Modify: `server/src/ops/ops.service.ts`：`OpKind` 改 `string`（`OpStatusSummary.kind: string`），其余不动
- Modify: `server/src/db/schema.ts`：`op_proposals` 去掉 kind 列 CHECK（Review Focus 5：README 追加一行"变更后需 pnpm db:rebuild"）
- Modify: `server/src/ops/ops.routes.ts`：签名 `opsRoutes(db, llm?, handlers: ReadonlyMap<string, OpHandler>)`；`cancel_op` 分支不变；动作分支按 `handlers.get(name)` 分发；`already`/`executed` 响应用 `readOpResult` + `{status, ...data, quip, deleted: data.deleted ?? false}`；执行成功后调 `handler.afterExecute?.({db, llm, opId}, data)`
- Modify: `server/src/app.ts`：`opsRoutes(db, llm, ASM.ops)`
- Modify: `server/src/agent/agent.ts`：propose_op payload 改按 `ASM.ops.get(kind)` 的 `argPayload` 校验（未知 kind → `{ok:false,error:"未知提议类型: x"}`）；重复检测、hint（改用 `handler.cardHint`）逻辑保留；execute_op 的 run 回调改 `handler.execute`，成功后 `handler.afterExecute`；响应 `{ok:true,status,...data}`（可接受 delta：delete 场景响应多出 `deleted:true` 字段）
- Delete: `server/src/ops/ops.executor.ts`、`server/src/ops/quip.ts`、`server/src/ops/quip.test.ts`（迁）
- Modify: `server/src/ops/ops.routes.test.ts`：改注入 fake handlers（kind `"stub_create"`：`argPayload: z.object({}).passthrough()`，execute 返回 `{ok:true,data:{stub:true}}`），原生命周期/守卫断言（TTL、幂等重放、OP_KIND_MISMATCH、404 未知动作）保留在 stub 语义下重写

- [ ] **Step 1: 写失败测试**：bill-ops.test.ts（迁移断言）+ ops.routes.test.ts stub 化 + agent.test.ts 追加"propose_op 未知 kind → ok:false"。
- [ ] **Step 2: 跑确认失败**：`cd server && npx vitest run src/ops ../features/bills/server/bill-ops.test.ts src/agent/agent.test.ts`。
- [ ] **Step 3: 实现**（顺序：bill-ops/quip 搬移 → index.ts 注册 → ops.service/routes/agent 改造 → 删旧文件）。
- [ ] **Step 4: 跑测试通过 + `pnpm -r test` 全绿**；提示用户开发库需 `pnpm db:rebuild`。
- [ ] **Step 5: Commit** `git commit -am "refactor: ops 按 OpHandler 分发，账单执行器与 quip 迁入 bills feature"`

### Task 8: web 组件入 feature + registry 组装 + op 网络设施收编 kernel/web

**Files:**
- Create: `features/bills/web/index.ts`：`export default defineWebFeature("bills", ctx => { ctx.component(BILL_COMPONENTS[0], () => import("./BillConfirmCard.vue")); … })`（BillList/BillItem 同）
- Create: `features/news/web/index.ts`（NewsList/NewsItem）、`features/shared/web/index.ts`（Metric/StatChart/EmptyState/ErrorState）
- Move: `web/src/render/components/Bill*.vue`(3) → `features/bills/web/`；`News*.vue`(2) → `features/news/web/`；`Metric/StatChart/EmptyState/ErrorState.vue` → `features/shared/web/`；`BillConfirmCard.test.ts` → `features/bills/web/`；`StatChart.test.ts` → `features/shared/web/`
- Move: `web/src/actions/handleAction.ts`、`web/src/actions/opsSync.ts` → `features/kernel/web.ts`（postAction/getOps 一并从 `web/src/api/client.ts` 移入；`client.ts` 只剩 streamChat/getMessages）
- Modify: `web/src/chat/ChatView.vue`（provideOpsSync 改从 `@llm-chat/features/web`）；`features/bills/web/BillConfirmCard.vue`（handleAction/useOpsSync 同上）
- Modify: `web/src/render/registry.ts` 重写：

```ts
import { assembleWebRegistry } from "@llm-chat/features/web";
const mods = import.meta.glob("../../../features/*/web/index.ts");
export const registry = await assembleWebRegistry(mods); // TLA；排除 /kernel/ 由组装器负责
```

- Modify: `web/src/chat/useChat.test.ts`、`web/src/chat/useHistory.test.ts`、`features/bills/web/BillConfirmCard.test.ts`：vi.mock 目标改 `@llm-chat/features/web`（mock postAction/handleAction/OpsSyncKey 路径）；`web/src/actions/handleAction.test.ts` → 迁为 `features/kernel/web.test.ts`? **否**——handleAction 行为测试留 web 侧：`web/src/render/kernel-web.test.ts`？**定为** `features/kernel/web.test.ts` 不可行（node 环境无 web include 覆盖）→ 放 `web/src/actions/kernel-web.test.ts`（原断言：网络失败转"连接失败，请稍后重试"、错误码透传）
- Delete: `web/src/render/components/`、`web/src/actions/handleAction.ts`、`web/src/actions/opsSync.ts`
- Test: `web/src/render/registry.test.ts` 重写：`Object.keys(registry).sort()` == 三个 shared 清单并集排序（Review Focus 2 的 web 侧）；并集常量从 `features/*/shared.ts` import

- [ ] **Step 1: 写失败测试**（registry.test.ts 新断言）。
- [ ] **Step 2: 跑确认失败**：`cd web && npx vitest run src/render/registry.test.ts`。
- [ ] **Step 3: 实现**（kernel/web 收编 → 组件搬移 + index.ts → registry 重写 → mock 路径更新 → 删旧目录）。
- [ ] **Step 4: 跑测试通过**：`cd web && npx vitest run`，再 `npx vite build`（验证 TLA + 包外 glob 可构建）。Expected: 全 PASS、build 成功。
- [ ] **Step 5: `pnpm -r test` 全绿；`pnpm dev` 手测：发"午饭 30 元"出卡→确认 saved；"看热点"出 NewsList。**
- [ ] **Step 6: Commit** `git commit -am "refactor: web 组件与 op 网络设施迁入 features，registry 改 glob 组装"`

### Task 9: 清理与文档收口

**Files:**
- Modify: `AGENTS.md`：替换"json-render 的 catalog 只在服务端…"条目为 features 架构说明（kernel 两上下文、shared.ts 单源、增删 feature 步骤：删两个目录即失效、组件一致性由 consistency/registry 测试守）；"架构关键点"其余条目复核
- Modify: `README.md`：SKILL 四步指南改为 feature 步骤（建 `features/<名>/{shared.ts,server/,web/}`、注册进上下文、写 consistency 断言、跑三套测试）；验收清单不变；Task 7 的 db:rebuild 提示落于此
- Create: `docs/superpowers/specs/2026-10-28-features-architecture.md`：记录本重构设计（上下文 API、扫描/组装语义、ops 泛化、约束）；并在 `2026-10-27-llm-chat-design.md` §9.3 等涉路径处加一行指向新文档（不重写原 spec 正文）
- Modify: 删除残留空目录（`server/src/agent` 只剩 agent.ts/prompts.ts 属预期保留）；`server/src/smoke.test.ts`、`web/src/smoke.test.ts` 复核仍覆盖装配路径

- [ ] **Step 1: 全量验证**：`pnpm -r test` 全绿；`pnpm dev` 手测：记账（创建/确认/修改/删除）、新闻（关键词/热点/来源降级提示）、历史恢复（刷新后卡片状态对账）。
- [ ] **Step 2: 文档更新**（AGENTS.md / README / 新 spec + 旧 spec 指针）。
- [ ] **Step 3: 演练"删业务"**：临时把 `features/news` 改名 → `cd server && npx vitest run src/agent/prompts.test.ts src/smoke.test.ts` 与 `cd web && npx vitest run src/render/registry.test.ts` 应仅因 shared 清单断言失败而**可预期地**暴露（这正是收口验证；演练后还原）。此步证明 Review Focus 1/2 的守卫生效。
- [ ] **Step 4: Commit** `git commit -am "docs: features 架构文档与 AGENTS/README 收口"`

## Self-Review 记录

- 规格覆盖： brainstorming 达成的全部决定（根目录 features 包、双上下文、自动扫描、shared.ts 单源、prompt/降级话术生成、ops 保持核心但执行器泛化、web 异步组件）均落到任务：包/上下文=T1/T2、扫描=T1/T3、DDL=T4/T5、catalog/prompt=T6a、tools/routes=T6b、ops=T7、web=T8、文档=T9。无缺项。
- 类型一致性：`route` 签名在 T1 定义为收 Router，T6b 改为 `(db)=>Router` 工厂——已在 T6b Step 1 显式列出回改 T1 测试，避免接口漂移失控；其余（ToolEntry/OpHandler/SkillSection/AssembledServer）各任务引用名一致。
- 步骤可执行性：每个任务有失败测试先行（T2、T9 除外，均为验证型任务且有明确验证命令）、精确 vitest 命令、独立 commit。
- Review Focus 5 条均有归属任务与测试（1→T6a、2→T6a/T8、3→T7、4→T1、5→T7 文档步骤）。
- 比例：10 个任务、以搬移+接线为主，新写代码集中在 kernel（T1/T2）与 prompts/registry 组装（T6a/T8），计划长度与改动面相称。
