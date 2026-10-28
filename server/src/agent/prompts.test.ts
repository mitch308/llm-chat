import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { SKILLS_PROMPT, CATALOG_PROMPT } from "./prompts";
import { TOOL_DEFS } from "./tools";
import { buildCatalog } from "./catalog";
import { buildContext } from "../chat/context";
import { createOpsService } from "../ops/ops.service";

let dirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-prompts-"));
  dirs.push(dir);
  db = getDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("SKILLS_PROMPT", () => {
  it("contains fallback copy, two-level category rule, and clarify rule", () => {
    expect(SKILLS_PROMPT).toContain("暂不支持该功能");
    expect(SKILLS_PROMPT).toContain("记账");
    expect(SKILLS_PROMPT).toContain("新闻");
    // 两级类目：父类/子类示例
    expect(SKILLS_PROMPT).toContain("交通");
    expect(SKILLS_PROMPT).toContain("打车");
    // 追问规则
    expect(SKILLS_PROMPT).toContain("追问");
  });
});

describe("CATALOG_PROMPT", () => {
  it("contains all 9 component names", () => {
    for (const name of [
      "BillConfirmCard",
      "BillList",
      "BillItem",
      "Metric",
      "StatChart",
      "NewsList",
      "NewsItem",
      "EmptyState",
      "ErrorState",
    ]) {
      expect(CATALOG_PROMPT).toContain(name);
    }
  });

  it("catalog validates a minimal BillConfirmCard spec", () => {
    const catalog = buildCatalog();
    const spec = {
      root: "c1",
      elements: {
        c1: {
          type: "BillConfirmCard",
          props: { op_id: "op_x", status: "pending", data: {}, quip: null },
          children: [],
        },
      },
    };
    const result = catalog.validate(spec) as { success: boolean; error?: unknown };
    expect(result.success).toBe(true);
  });
});

describe("TOOL_DEFS", () => {
  it("defines the five tools with propose_op payload conventions", () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "query_bills",
        "bills_stats",
        "propose_op",
        "execute_op",
        "search_news",
      ]),
    );
    const propose = TOOL_DEFS.find((t) => t.function.name === "propose_op")!;
    const props = propose.function.parameters.properties as Record<string, unknown>;
    const payload = props.payload as { properties: Record<string, { type?: string }> };
    expect(payload.properties.amount_yuan.type).toBe("number");
    expect(payload.properties.category.type).toBe("string");
  });
});

describe("buildContext wiring", () => {
  it("system includes skills + catalog and the authoritative op-status block", () => {
    createOpsService(db).proposeOp("bill_create", { item: "衣服", amount_yuan: 200 });

    const { system } = buildContext(db);
    expect(system).toContain("暂不支持该功能"); // 来自 SKILLS_PROMPT
    expect(system).toContain("BillConfirmCard"); // 来自 CATALOG_PROMPT
    expect(system).toContain("提议状态");
    expect(system).toContain("待确认");
    expect(system).toContain("衣服");
  });

  it("no op-status block without proposals", () => {
    const { system } = buildContext(db);
    expect(system).not.toContain("提议状态");
  });
});
