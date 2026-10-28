# llm-chat

单机单用户的对话式助理：自然语言记账（二次确认 + 俏皮话）与新闻按需查询，回答以 json-render 富界面在单一聊天框内流式渲染。

- 需求设计：`docs/superpowers/specs/2026-10-27-llm-chat-design.md`
- features 架构（业务目录与扩展方式）：`docs/superpowers/specs/2026-10-28-features-architecture.md`
- 实施计划：`docs/superpowers/plans/2026-10-27-llm-chat.md`

## 架构

```
web (Vue3+TS)  ── HTTP/SSE ──  server (Node+TS 单服务)
                                  ├─ REST API（消息/账单/新闻/动作）
                                  ├─ AGENT 运行时（glm-5.3-flash 工具循环 + json-render inline spec 流式分离）
                                  └─ SQLite（better-sqlite3，FTS5 可用则全文检索，否则 LIKE 降级）
```

## 快速开始

```bash
pnpm install
pnpm dev          # server(127.0.0.1:8787) + web(localhost:5173) 并行
pnpm db:rebuild   # 删库重建（schema + 类目种子；dev server 需先停）
```

> 变更后需 `pnpm db:rebuild`（原因：kind 列 CHECK 移除，旧开发库插入非 bill kind 会失败）。

环境变量（server 读取，放 `server/.env`——模板见 `server/.env.example`；Node 22 启动时自动加载）：

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `ZHIPU_API_KEY` | 是 | — | 智谱开放平台 API key（对话/俏皮话/新闻摘要） |
| `ZHIPU_MODEL` | 否 | `glm-5.3-flash` | 大模型名 |
| `ZHIPU_BASE_URL` | 否 | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容端点 |
| `GUARDIAN_API_KEY` | 否 | — | Guardian 开放平台 key，缺失时该新闻源禁用 |
| `RSSHUB_BASE` | 否 | `https://rsshub.app` | RSSHub 基地址（国内网络建议自托管后覆盖） |
| `PORT` | 否 | `8787` | 服务端口（仅监听 127.0.0.1） |
| `DB_PATH` | 否 | `server/data/llm-chat.db` | SQLite 文件路径 |

测试（不依赖网络与真实 API key）：

```bash
pnpm -r test
```

## 如何新增一个 feature（四步）

业务（如记账、新闻）都在仓库根 `features/<名>/` 目录内，核心不感知具体业务。详见 `docs/superpowers/specs/2026-10-28-features-architecture.md`。

1. **建目录**：`features/<名>/shared.ts`（组件/动作清单 + Props zod，单一来源、两侧共用）+ `features/<名>/server/`（DDL、service、routes、tools、skill 提示词、op 执行器）+ `features/<名>/web/`（Vue 组件）
2. **注册**：`server/index.ts` 与 `web/index.ts` 各 default 导出 `defineServerFeature` / `defineWebFeature`，经 ctx 注册全部贡献物（ddl/seed/route/tool/catalog/skill/ops 与 component）——server 扫描与 web glob 会自动生效，无需改核心接线
3. **一致性断言**：`features/kernel/consistency.test.ts` 与 `web/src/render/registry.test.ts` 的清单并集断言里加上你的 `*_COMPONENTS`（有动作则同时加 consistency 的动作断言）
4. **测试门禁**：`pnpm -r test` 全绿 + `cd web && npx vite build` 成功

删除一个 feature = 把目录移出 `features/` 或整体删除（在 features/ 内改名不会移除——扫描只看目录内是否含 `server/index.ts`）+ 清掉两处一致性断言里的清单引用；漏清会得到守卫测试的模块收集错误（Cannot find module；新增漏加清单则是并集断言失败），不会静默丢失。

## 验收清单（spec 第 14 节）

1. U1–U10 全路径（确认前库中无记录；双击/双通道/重放只产生一条账单；过期提议被拒；动作类型不匹配被拒）— ✅ 自动化测试覆盖（server 83 + web 31 = 114 用例）
2. 刷新后历史文字与卡片完整重现（含 100 条窗口外上翻找回）— ✅ 代码路径已实现；⏳ 真实模型端到端待 API key 手测
3. 断网/后端异常时确认卡片错误态可重试 — ✅ BillConfirmCard/handleAction 测试
4. "订机票""你好"得到暂不支持话术 — ✅ 路由提示词 + fallback 测试；⏳ 真实模型待手测
5. 关键词扩展（搜 AI 命中 LLM）+ 外文译题/≤100字摘要/原文链接 — ✅ FTS 多词 OR 测试；⏳ 模型侧扩展与真源待手测
6. 交通=父类汇总，打车=子类 — ✅ bills.stats 测试
7. 无查询时进程零新闻抓取 — ✅ 按需服务测试（缓存新鲜零调用）
8. 历史区间仅 HN/Guardian，超范围返回不支持 — ✅ searchNews 测试
9. 俏皮话基于真实统计、退款夸奖、超时不阻塞 — ✅ quip 测试
10. 碎片补充合并、切话题后 10 分钟内可恢复记账 — ✅ 上下文注入/提议生命周期测试；⏳ 真实模型待手测

⏳ 项需要 `ZHIPU_API_KEY` 后手工全量过一遍（见 spec 第 14 节）。
