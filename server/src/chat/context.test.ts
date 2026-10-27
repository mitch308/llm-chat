import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createMessagesService } from "../messages/messages.service";
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

  it("system contains Shanghai date/weekday and prompt placeholders", () => {
    const { system } = buildContext(freshDb());
    const now = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(new Date());
    expect(system).toContain(now);
    expect(system).toContain("{{SKILLS}}");
    expect(system).toContain("{{CATALOG}}");
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
});
