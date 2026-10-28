# shared —— 通用渲染组件

不属于任何业务的 catalog 通用组件，被各业务 spec 卡片复用。只贡献组件定义，没有 DDL / 路由 / 工具 / 技能 prompt / ops。

## 内容

| 文件 | 职责 |
|---|---|
| `shared.ts` | `SHARED_COMPONENTS` 清单（`Metric` / `StatChart` / `EmptyState` / `ErrorState`）+ 各组件 props zod（两端单一契约源） |
| `server/index.ts` | `defineServerFeature("shared", …)`：仅 `ctx.catalogComponents`（四个组件的 catalog 定义） |
| `web/index.ts` | `defineWebFeature("shared", …)`：懒加载注册四个组件 |
| `web/Metric.vue` | 单指标数值展示（如"本月总支出 ¥2,340"，支持 currency/number/percent 格式） |
| `web/StatChart.vue` | 统计图表（`bar` 类目占比 / `line` 按日趋势，基于 echarts） |
| `web/EmptyState.vue` | 空结果状态 |
| `web/ErrorState.vue` | 错误状态（`retryable=true` 时显示重试按钮） |
| `web/StatChart.test.ts` | StatChart 渲染测试 |

## 约定

- 这里只放**业务无关**的展示组件；新组件若只服务于单个业务，放该业务的 `web/` 下并在其 `shared.ts` 清单里登记。
- 组件加入后需同步：`SHARED_COMPONENTS` 清单 → `server/index.ts` catalogComponents → `web/index.ts` 注册 → `features/kernel/consistency.test.ts` 与 `web/src/render/registry.test.ts` 的并集断言会自动覆盖（它们从各 `shared.ts` 汇总，无需改测试）。
- 注册顺序说明：目录名排序 bills < news < shared，shared 的 catalog 条目排在最后，仅影响枚举顺序，无语义。
