import { createApp } from "./app";
import { getDb } from "./db/connection";

const port = Number(process.env.PORT ?? 8787);
const db = getDb(process.env.DB_PATH);
const app = createApp({ db });

app.listen(port, "127.0.0.1", () => {
  console.log(`llm-chat server listening on http://127.0.0.1:${port}`);
});
