import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { ASM } from "../features";
import type { SkillSection } from "@llm-chat/features/server";
import { SKILLS_PROMPT, CATALOG_PROMPT, composeSkillsPrompt } from "./prompts";
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
    // 两级类目：父类/子类示例（随记账专属 bullet 迁入记账技能 body）
    expect(SKILLS_PROMPT).toContain("交通");
    expect(SKILLS_PROMPT).toContain("打车");
    // 追问规则
    expect(SKILLS_PROMPT).toContain("追问");
  });

  it("通用规则改通用措辞：追问示例与写库 bullet（Task 6a 裁定）", () => {
    expect(SKILLS_PROMPT).toContain("例如订机票没说目的地");
    expect(SKILLS_PROMPT).toContain("需要写库的操作一律先生成确认卡片，禁止直接写库");
    expect(SKILLS_PROMPT).not.toContain("这笔花了多少钱");
    expect(SKILLS_PROMPT).not.toContain("（记/改/删）");
  });
});

describe("composeSkillsPrompt", () => {
  const mkSkill = (over: Partial<SkillSection>): SkillSection => ({
    intent: "测试意图",
    label: "测试技能",
    hint: "🧪测试",
    body: "# 测试技能\n\n正文",
    ...over,
  });

  it("单 skill → 只允许以下2类结果，fallback 行含该 skill 的 hint", () => {
    const p = composeSkillsPrompt([mkSkill({ hint: "🧪测试（演示）" })]);
    expect(p).toContain("只允许以下2类结果");
    expect(p).toContain("1. 测试意图 → 走【测试技能】");
    expect(p).toContain("2. 其他一切（包括问候、闲聊、订机票等）→ 只回复：");
    expect(p).toContain("暂不支持该功能，目前支持：🧪测试（演示）");
    expect(p).toContain("# 测试技能"); // body 原样拼接
  });

  it("两 skill → 3 类结果，fallback hints 用「、」拼接", () => {
    const p = composeSkillsPrompt([
      mkSkill({
        intent: "记账意图（记录/查询/修改/删除账单）",
        label: "记账技能",
        hint: "📝记账（记录/查询/修改/删除）",
      }),
      mkSkill({
        intent: "新闻意图（关键词搜索/热点浏览/指定来源）",
        label: "新闻技能",
        hint: "📰新闻（关键词搜索/热点浏览）",
      }),
    ]);
    expect(p).toContain("只允许以下3类结果");
    expect(p).toContain("1. 记账意图（记录/查询/修改/删除账单） → 走【记账技能】");
    expect(p).toContain("2. 新闻意图（关键词搜索/热点浏览/指定来源） → 走【新闻技能】");
    expect(p).toContain(
      "暂不支持该功能，目前支持：📝记账（记录/查询/修改/删除）、📰新闻（关键词搜索/热点浏览）",
    );
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
    // 原 buildCatalog() 已删，等价改为 ASM.catalog（feature 贡献组装的合并目录）
    const catalog = ASM.catalog;
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

  it("omits the op-status block when no proposals exist", () => {
    const { system } = buildContext(db);
    expect(system).not.toContain("提议状态（");
  });
});
