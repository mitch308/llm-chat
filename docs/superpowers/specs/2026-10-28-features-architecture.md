# features 架构（2026-10-28 重构）

> 本文记录 bills/news/shared 三大业务自 `server/src`、`web/src` 迁入 `features/` 工作区包后的目标架构。
> 需求语义（用例、提示词措辞、API 行为）仍以 `2026-10-27-llm-chat-design.md` 为权威；本文只描述**代码组织与扩展方式**，两文冲突时组织问题以本文为准。

## 1. 意图与背景（Why）

重构前，新增/删除一个业务（如新闻）需要在 `server/src`（DDL、service、routes、catalog、prompts、tools、agent 接线）与 `web/src`（组件、registry）各改多处核心文件，业务知识与核心运行时耦合。重构后：**一个业务 = `features/` 下一个目录**，核心（agent 循环、ops 生命周期、装配）不感知具体业务，只消费 feature 注册的贡献物。

## 2. 目录结构

```
features/                        # 工作区包 @llm-chat/features（exports: ./server、./web）
├─ kernel/
│  ├─ server.ts                  # ServerFeatureContext / assemble / scan / OpHandler 等类型与装配器
│  ├─ web.ts                     # WebFeatureContext / registry 组装器 / op 网络设施（postAction 等）
│  └─ *.test.ts                  # kernel 单测 + 三份 shared 清单的 catalog 一致性断言
├─ bills/
│  ├─ shared.ts                  # 组件/动作清单 + Props zod（单一来源，node-safe 仅依赖 zod）
│  ├─ server/                    # index.ts（注册入口）+ DDL/种子/service/routes/tools/op 执行器
│  └─ web/                       # index.ts（注册入口）+ Vue 组件
├─ news/                         # 结构同上
└─ shared/                       # 跨 feature 通用组件（Metric/StatChart/EmptyState/ErrorState）
```

server 侧测试由 `server/vitest.config.ts` 收集（`../features/*/server/**/*.test.ts` 与 `../features/kernel/*.test.ts`），web 侧由 `web/vitest.config.ts` 收集（`../features/*/web/**/*.test.ts`）——features 包自身无 test 脚本。

## 3. 双上下文 API

### 3.1 ServerFeatureContext（`kernel/server.ts`）

feature 的 `server/index.ts` default 导出 `defineServerFeature(name, register)`，register 收到的上下文可注册：

| 方法 | 贡献物 | 消费方 |
|---|---|---|
| `ddl(stmt \| string[])` | 建表 DDL（顺序执行） | `db/connection.ts` getDb |
| `ddlOptional(stmt)` | 可选 DDL（失败仅记录并降级，如 FTS5 虚表） | 同上 + FTS 旗标 |
| `seed(run)` | 种子函数 | getDb 建表后执行 |
| `route(fn)` | `(db) => Router` 工厂 | `app.ts` 动态挂 `/api` |
| `tool(def, {schema, execute})` | 模型工具（def + zod 入参 + 执行体） | agent 循环注册表分发 |
| `catalogComponents(defs)` | 组件目录（props zod + description） | `catalog.prompt()` 生成系统提示词 |
| `catalogActions(defs)` | 动作目录 | 同上 |
| `skill(section)` | 技能段（intent/label/hint/body） | `composeSkillsPrompt` 组装路由与工作流 |
| `ops(kinds, handler)` | 写操作提议的执行器 | ops 服务按 kind 分发 |

### 3.2 WebFeatureContext（`kernel/web.ts`）

feature 的 `web/index.ts` default 导出 `defineWebFeature(name, register)`，上下文只有 `component(type, comp)`：组件对象或懒加载器（`() => import("X.vue")`，装配时包 `defineAsyncComponent`）。

### 3.3 核心与业务的边界

留在 server 核心的：messages/chat（SSE、上下文、流分离）、ops（提议生命周期服务与 REST）、db 连接（装配 DDL）、agent 循环（含内置 propose_op/execute_op 工具）、`app.ts` 装配。留在 web 核心的：聊天 UI、SSE 消费、消息流。业务的一切（表、路由、工具、目录、提示词、组件、op 执行）都在 feature 目录里。

## 4. 扫描与组装语义

### 4.1 server 侧：自动扫描（`server/src/features.ts` 的 ASM）

- 模块加载时扫描仓库根 `features/`：**凡含 `server/index.ts` 的子目录即一个 feature**；
- 目录名**排序后**逐个动态导入取 default 导出（`scanServerFeatures`），顺序确定性 = DDL 顺序、技能顺序、工具清单顺序的保证（当前 bills < news < shared）；
- `assembleServerFeatures` 按序调用各 register，汇总为 `AssembledServer`（ddl/ddlOptional/seedFns/routers/tools/catalog/skills/ops）；
- 将 feature 目录**移出 `features/`（或整体删除）**即把它从装配中移除，**无需改任何核心文件**；注意**在 features/ 内改名不会移除**——扫描只看目录内是否含 `server/index.ts`（如 `news` → `news.bak` 仍会被装配）。

### 4.2 web 侧：glob + 顶层 await（`web/src/render/registry.ts`）

- `import.meta.glob("../../../features/*/web/index.ts")` 收集各 feature 的 web 入口，路径排序后逐个加载 default 导出并注册组件；
- `/kernel/` 路径由组装器排除（防自吸）；registry 经 `await assembleWebRegistry(mods)` 顶层 await 产出。

### 4.3 fail-fast

组装期键冲突直接抛错（不静默覆盖）：tool 名、catalog 组件名、catalog action 名（含核心内置 `cancel_op`，feature 不可覆盖）、op kind、web 组件 type。web feature 模块缺 default 导出同样抛错。

## 5. shared.ts 单源一致性策略

每个 feature 的 `shared.ts` 是其组件契约的**单一来源**：`*_COMPONENTS` / `*_ACTIONS` 清单 + Props zod（node-safe，仅依赖 zod，两侧均可导入）。server 的 `catalogComponents` 与 web 的 `ctx.component` 都从同一清单取名，两侧不会逐字漂移。

一致性由两处测试守（**删 feature 时它们可预期地失败，这正是删业务可检测的机制**）：

- `features/kernel/consistency.test.ts`：ASM.catalog 组件键集合 == 三份清单并集；动作键集合 == `BILL_ACTIONS` + 内置 `cancel_op`；技能按目录名排序注册；
- `web/src/render/registry.test.ts`：registry 键集合 == 三份清单并集，且注册项可实际渲染。

## 6. ops 的 OpHandler 泛化

ops 仍是核心设施（生命周期不变：服务端发 op_id、全局最多 1 个 pending、TTL 10 分钟、executed 幂等重放、动作路由 kind 一致性守卫 409 OP_KIND_MISMATCH），但执行器泛化为注册表：

```ts
interface OpHandler {
  argPayload: ZodType;                       // propose_op 的 payload 校验（按 kind 查）
  execute(payload, env): Promise<RunResult> | RunResult;
  afterExecute?(env & { opId }, data): void; // 写结果 + quip 等后置（异步补写）
  cardHint?: { created: string; duplicate: string }; // 新建/重复提议两条回喂的 spec 卡片指令
}
```

- feature 用 `ctx.ops(kinds, handler)` 注册；bills 的三个 bill kind 各闭包一个 handler；
- agent 内置的 `propose_op` 工具 kind enum 由注册表派生（`[...ASM.ops.keys()]`），未知 kind 回喂模型自查；
- `POST /api/actions/:name` 按 `ASM.ops` 分发；`cancel_op` 为核心内置动作，不属任何 feature；
- op 结果以 `{data, quip}` 形状存 `op_proposals.result_json`（kernel 提供 read/writeOpResult）。

## 7. 增 / 删一个 feature 的步骤

**新增**：① 建目录 `features/<名>/{shared.ts, server/, web/}`，两侧 index.ts default 导出 define*Feature 并经 ctx 注册全部贡献物；② server/web 无需接线——扫描与 glob 自动生效；③ 在 `features/kernel/consistency.test.ts` 与 `web/src/render/registry.test.ts` 的清单并集断言里加上你的 `*_COMPONENTS`（有动作则加 consistency 的动作断言）；④ 跑三套测试（`pnpm -r test`）+ `cd web && npx vite build`。

**删除**：① 将目录移出 `features/` 或整体删除（装配即移除，核心无需改；**features/ 内改名不会移除**——扫描只看目录内是否含 `server/index.ts`）；② 清掉两处一致性测试里对该 feature 清单的引用；③ 全量测试确认绿。漏做第②步：守卫测试对已删 `shared.ts` 的静态 import 直接产生**模块收集错误**（`Cannot find module '../news/shared'），比断言更早、同样响亮，不会静默丢失。区分：**新增** feature 漏加清单才会以并集断言失败的形态暴露（两侧集合不等）——两种方向都有守卫接住。

## 8. 约束

- 不要在 web 复制 catalog 定义：组件契约只写一份（`shared.ts`），server 注册 props/description，web 注册实现；
- `shared.ts` 保持 node-safe（仅 zod）：它同时被 server（纯 Node 测试）与 web（vite/jsdom）导入；
- feature 之间不互相导入（跨业务复用放 `features/shared/`）；
- 写操作必须走 ops 提议生命周期，禁止 feature 路由直接写库（kind 守卫会拒绝绕过）。
