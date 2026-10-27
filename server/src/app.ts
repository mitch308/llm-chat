import express, { type Express } from "express";
import type Database from "better-sqlite3";
import { messagesRoutes } from "./messages/messages.routes";
import { chatRoutes } from "./chat/chat.routes";
import { billsRoutes } from "./bills/bills.routes";
import type { LLMClient } from "./chat/llm";

export interface AppDeps {
  db: Database;
  llm?: LLMClient;
}

/** 依赖注入的 app 工厂：测试注入临时库与 fake LLM，生产注入 getDb()。 */
export function createApp({ db, llm }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", messagesRoutes(db));
  app.use("/api", billsRoutes(db));
  app.use("/api", chatRoutes(db, llm));
  return app;
}
