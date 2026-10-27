import express, { type Express } from "express";
import type Database from "better-sqlite3";
import { messagesRoutes } from "./messages/messages.routes";

export interface AppDeps {
  db: Database;
}

/** 依赖注入的 app 工厂：测试注入临时库，生产注入 getDb()。 */
export function createApp({ db }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", messagesRoutes(db));
  return app;
}
