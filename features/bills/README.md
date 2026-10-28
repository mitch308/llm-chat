# bills —— 记账业务

记账功能的完整闭环：记录 / 查询 / 统计 / 修改 / 删除，写操作走服务端提议生命周期（确认卡片 → 用户确认 → 落库）。

## 目录结构

| 路径 | 职责 |
|---|---|
| `shared.ts` | 两端单一契约源：`BILL_COMPONENTS` / `BILL_ACTIONS` 清单 + `BillConfirmCard` / `BillList` / `BillItem` 的 props zod（catalog 定义与 web 组件共用，保证逐字一致） |
| `server/index.ts` | `defineServerFeature("bills", …)` 入口：注册 DDL / 种子 / catalog / 动作 / 技能 prompt / 工具 / 路由 / ops handlers |
| `server/seeds.ts` | 两级类目种子（`CATEGORY_SEEDS` + `seedCategories`，幂等写入） |
| `server/bills.service.ts` | 账单数据层（`amount_cents` 整数存储；父类名查询展开为全部子类） |
| `server/bills.routes.ts` | REST：`GET /api/bills`、`GET /api/bills/stats`、`POST /api/bills`、`PATCH /api/bills/:id`、`DELETE /api/bills/:id` |
| `server/tools.ts` | Agent 工具 `query_bills` / `bills_stats`（定义 + zod schema + 执行体） |
| `server/bill-ops.ts` | op 执行器：`runBillAction`（payload 校验 + 写库）、`resolveLeafCategoryId`、`yuanToCents`、`monthRange`；`billOpHandler(kind)` 工厂生成 `bill_create` / `bill_update` / `bill_delete` 三个 `OpHandler`（含卡片 hint 文案） |
| `server/quip.ts` | 确认后的俏皮话生成（后台补写进 `result_json`，不阻塞确认响应） |
| `web/index.ts` | `defineWebFeature("bills", …)` 入口：懒加载注册三个组件 |
| `web/BillConfirmCard.vue` | 确认卡片（pending / saved / cancelled / expired / error 状态机，按钮走 `POST /api/actions/:name`） |
| `web/BillList.vue` / `web/BillItem.vue` | 查询结果列表 / 单行 |

## 注册贡献物一览（`server/index.ts`）

`ctx.ddl`（categories 先于 bills，FK 依赖）→ `ctx.seed` → `ctx.catalogComponents` / `ctx.catalogActions` → `ctx.skill`（记账技能三段 + 金额/类目两条通用规则 bullet）→ `ctx.tool` ×2 → `ctx.route` → `ctx.ops(["bill_create","bill_update","bill_delete"], …)`。

## 关键约束（改动前必读）

- 金额库内一律 **`amount_cents` 整数**，payload 侧用 `amount_yuan`（元，正数），转换只经 `yuanToCents`。
- bills 必须挂**叶子类目**；`resolveLeafCategoryId` 对父类名做叶子解析（优先匹配 item 中出现的叶子名）。
- 写操作必须经提议生命周期（`propose_op` → 确认卡片/文字确认 → `execute_op` / `POST /api/actions/:name`），动作名必须与提议 kind 一致（409 OP_KIND_MISMATCH），不要绕过。
- quip 生成走后台补写（`attachQuipInBackground`），确认响应里 `quip` 恒为 `null`，由对账信号触发卡片刷新后读到。

## 测试

`server/bills.test.ts`（service + REST）、`server/bill-ops.test.ts`（执行器校验/类目解析/OpHandler 装配）、`server/quip.test.ts`（俏皮话）、`server/ops-wiring.test.ts`（生产装配下确认按钮 HTTP 全链路）；`web/BillConfirmCard.test.ts`（卡片状态机与动作）。

## 增删本 feature

增删业务的通用流程见 [AGENTS.md「features 架构」](../../AGENTS.md) 与 [features 架构 spec](../kernel/../../docs/superpowers/specs/2026-10-28-features-architecture.md)（相对本目录：`../../docs/superpowers/specs/2026-10-28-features-architecture.md`）。删除时同步清理 `features/kernel/consistency.test.ts` 与 `web/src/render/registry.test.ts` 里对 `BILL_COMPONENTS` / `BILL_ACTIONS` 的并集断言引用。
