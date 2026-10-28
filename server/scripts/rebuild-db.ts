/**
 * 删库重建 CLI：pnpm db:rebuild [dbPath]
 * 默认路径 server/data/llm-chat.db；dev server 未停时 Windows 下会 EBUSY 报错并退出。
 */
import { closeDb } from "../src/db/connection";
import { rebuildDb } from "../src/db/rebuild";

try {
  const result = rebuildDb(process.argv[2]);
  if (result.removedFiles.length > 0) {
    console.log(
      `✓ 已删除 ${result.dbPath}（含旁文件，共 ${result.removedFiles.length} 个）`,
    );
  } else {
    console.log(`• ${result.dbPath} 不存在，直接新建`);
  }
  console.log(
    `✓ 已重建：${result.tableCount} 张表、${result.categoryCount} 个类目种子、` +
      (result.fts5Enabled
        ? "FTS5 可用（news_fts 已建）"
        : "FTS5 不可用（检索降级 LIKE）"),
  );
  closeDb(result.dbPath);
} catch (err) {
  console.error(`× ${(err as Error).message}`);
  process.exit(1);
}
