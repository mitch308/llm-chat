import { createApp } from "./app";
import { getDb } from "./db/connection";

// 加载 server/.env（存在时）；Node 22 原生支持
try {
  process.loadEnvFile();
} catch {
  // 无 .env 文件：依赖真实环境变量
}

const port = Number(process.env.PORT ?? 8787);
const db = getDb(process.env.DB_PATH);
const app = createApp({ db });

app.listen(port, "127.0.0.1", () => {
  console.log(`llm-chat server listening on http://127.0.0.1:${port}`);
});
