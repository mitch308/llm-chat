# llm-chat

单机单用户的对话式助理：自然语言记账（二次确认 + 俏皮话）与新闻按需查询，回答以 json-render 富界面在单一聊天框内流式渲染。

- 需求设计：`docs/superpowers/specs/2026-10-27-llm-chat-design.md`
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
```

环境变量（server 读取，可放 `server/.env`）：

| 变量 | 必需 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | 是 | 智谱开放平台 API key（对话/俏皮话/新闻摘要） |
| `GUARDIAN_API_KEY` | 否 | Guardian 开放平台 key，缺失时该新闻源禁用 |
| `RSSHUB_BASE` | 否 | RSSHub 基地址（默认 `https://rsshub.app`；国内网络建议自托管后覆盖） |
| `PORT` | 否 | 服务端口，默认 8787（仅监听 127.0.0.1） |
| `DB_PATH` | 否 | SQLite 文件路径，默认 `server/data/llm-chat.db` |

测试（不依赖网络与真实 API key）：

```bash
pnpm -r test
```

## 如何新增一个 SKILL（四步）

1. **后端 API**：在 `server/src/<domain>/` 写 service + routes，挂到 `server/src/app.ts`
2. **catalog**：在 `server/src/agent/catalog.ts` 增加组件 zod 定义与动作（组件名与 web registry 一一对应）
3. **工作流 + 工具**：`server/src/agent/prompts.ts` 增加路由与逐步工作流描述；`server/src/agent/tools.ts` 增加工具；`server/src/agent/agent.ts` 的 `executeTool` 接线执行体
4. **前端组件**：`web/src/render/components/` 写 Vue 组件，在 `web/src/render/registry.ts` 注册

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
