import express, { type Express } from "express";
import type Database from "better-sqlite3";
import { messagesRoutes } from "./messages/messages.routes";
import { chatRoutes } from "./chat/chat.routes";
import { opsRoutes } from "./ops/ops.routes";
import type { LLMClient } from "./chat/llm";
import { ASM } from "./features";

export interface AppDeps {
  db: Database.Database;
  llm?: LLMClient;
}

/** 依赖注入的 app 工厂：测试注入临时库与 fake LLM，生产注入 getDb()。 */
export function createApp({ db, llm }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", messagesRoutes(db));
  app.use("/api", opsRoutes(db, llm, ASM.ops));
  app.use("/api", chatRoutes(db, llm));
  // feature 贡献的 REST 路由（bills/news）经 ASM 动态挂载
  for (const routeFactory of ASM.routers) app.use("/api", routeFactory(db));
  return app;
}
