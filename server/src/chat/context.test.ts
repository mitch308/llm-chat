import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createMessagesService } from "../messages/messages.service";
import { createOpsService } from "../ops/ops.service";
import { buildContext } from "./context";

let dirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-ctx-"));
  dirs.push(dir);
  return getDb(path.join(dir, "test.db"));
}

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("buildContext", () => {
  it("keeps only the latest 20 messages in chronological order", () => {
    const db = freshDb();
    const svc = createMessagesService(db);
    for (let i = 1; i <= 25; i++) {
      svc.appendMessage({ role: "user", contentText: `msg${i}` });
    }
    const { messages } = buildContext(db);
    expect(messages).toHaveLength(20);
    expect(messages[0].content).toBe("msg6");
    expect(messages[messages.length - 1].content).toBe("msg25");
  });

  it("compresses assistant spec_json to a one-line card summary", () => {
    const db = freshDb();
    const svc = createMessagesService(db);
    svc.appendMessage({ role: "user", contentText: "记一笔" });
    svc.appendMessage({
      role: "assistant",
      contentText: "帮你记好了",
      specJson: JSON.stringify([
        '{"op":"add","path":"/root","value":"card-1"}',
        '{"op":"add","path":"/elements/card-1","value":{"type":"BillConfirmCard","props":{"title":"记账"}}}',
      ]),
    });

    const { messages } = buildContext(db);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("[卡片:");
    expect(assistant.content).toContain("BillConfirmCard");
    expect(assistant.content).not.toContain('"op":"add"');
  });

  it("system contains Shanghai date/weekday and skills+catalog wiring anchors", () => {
    const { system } = buildContext(freshDb());
    const now = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(new Date());
    expect(system).toContain(now);
    // Task 10 接线后：占位符已替换为 skills 与 catalog 提示词
    expect(system).toContain("技能路由");
    expect(system).toContain("OUTPUT FORMAT");
  });

  it("truncates oldest messages when context exceeds 12000 chars", () => {
    const db = freshDb();
    const svc = createMessagesService(db);
    const filler = "x".repeat(900);
    for (let i = 1; i <= 25; i++) {
      svc.appendMessage({ role: "user", contentText: `${filler}#${i}` });
    }
    const { messages } = buildContext(db);
    expect(messages.length).toBeLessThan(20);
    expect(messages.length).toBeGreaterThan(0);
    const total = messages.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(12000);
    // 保留的是最新的
    expect(messages[messages.length - 1].content).toContain("#25");
  });

  it("injects authoritative op-status so button-confirmed proposals are visible (回归：状态不同步)", async () => {
    const db = freshDb();
    const msgs = createMessagesService(db);
    const ops = createOpsService(db);
    msgs.appendMessage({ role: "user", contentText: "今天早饭花了3元" });
    const p = ops.proposeOp("bill_create", {
      amount_yuan: 3,
      item: "早饭",
      date: "2026-10-28",
    });
    msgs.appendMessage({ role: "assistant", contentText: "帮你记一笔，请确认" });
    // 用户点确认按钮 → 动作路由执行的同一生命周期
    await ops.executeOp(p.op_id, async () => ({ ok: true, data: {} }));

    const { system } = buildContext(db);
    expect(system).toContain("提议状态");
    expect(system).toContain("已确认保存");
    expect(system).toContain("早饭");
    expect(system).toContain("¥3");
    expect(system).toContain(p.op_id); // 供后续文字"确认"调用 execute_op
  });

  it("omits the op-status block when no proposals exist", () => {
    const { system } = buildContext(freshDb());
    expect(system).not.toContain("提议状态（");
  });
});
