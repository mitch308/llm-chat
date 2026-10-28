# kernel —— features 机制本身（不是业务 feature）

本目录是插件架构的**基础设施**：定义双端注册上下文、扫描组装器与一致性守卫测试。它没有 `shared.ts`，也不向上下文注册任何业务内容（`__fixtures__/demo` 仅是扫描测试夹具）。

| 文件 | 职责 |
|---|---|
| `server.ts` | **服务端上下文**（`@llm-chat/features/server`）：`defineServerFeature` + `ServerFeatureContext`（`ddl` / `ddlOptional` / `seed` / `route` / `tool` / `catalogComponents` / `catalogActions` / `skill` / `ops`）、`scanServerFeatures`（按目录名排序，动态 import 各 feature 的 `server/index.ts`）、`assembleServerFeatures`（顺序组装；tool/组件/动作/op kind 键冲突直接抛错；内置 `cancel_op` action）、`readOpResult` / `writeOpResult`（`op_proposals.result_json` 的 `{data, quip}` 契约）、FTS5 可用旗标；另声明 LLM wire 类型（`ToolDef` / `LLMClient` 等，`server/src/chat/llm.ts` 从这里 re-export，**唯一定义处**） |
| `web.ts` | **Web 上下文**（`@llm-chat/features/web`）：`defineWebFeature` + `assembleWebRegistry`（`import.meta.glob` 产物 → 排序注册；函数形式的组件自动包 `defineAsyncComponent`；组件 type 冲突或缺 default 导出直接抛错；排除 `/kernel/` 路径）。调用方需 top-level await（见 `web/src/render/registry.ts`） |
| `server.test.ts` / `consistency.test.ts` | 组装语义测试 + 守卫测试（catalog 组件/动作键集合 == 各 feature `shared.ts` 清单并集；后者消费生产 `ASM`） |

## 设计要点（细节见架构 spec）

- **扫描规则**：`features/` 下任何含 `server/index.ts` 的目录都会被装配——**在 features/ 内改名不会移除一个 feature**，删除/移出才会。
- **注册顺序** = 目录名排序（bills < news < shared），决定 DDL 顺序与技能 prompt 拼接顺序。
- **fail-fast**：同名工具/组件/动作/op kind 重复注册在组装期抛错，不允许静默覆盖。
- 完整设计：[features 架构 spec](../../docs/superpowers/specs/2026-10-28-features-architecture.md)；新增/删除业务的操作步骤见 [AGENTS.md「features 架构」](../../AGENTS.md)。
