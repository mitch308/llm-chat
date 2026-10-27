import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createApp } from "../app";
import { createMessagesService } from "./messages.service";

let dirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-msg-"));
  dirs.push(dir);
  return getDb(path.join(dir, "test.db"));
}

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("messages service", () => {
  it("lists newest-first and paginates with before_id", () => {
    const svc = createMessagesService(freshDb());
    for (const t of ["一", "二", "三", "四", "五"]) {
      svc.appendMessage({ role: "user", contentText: t });
    }
    const all = svc.listMessages({ limit: 100 });
    expect(all.map((m) => m.content_text)).toEqual(["五", "四", "三", "二", "一"]);

    const third = all.find((m) => m.content_text === "三")!;
    const page = svc.listMessages({ beforeId: third.id, limit: 2 });
    expect(page.map((m) => m.content_text)).toEqual(["二", "一"]);
  });

  it("stores spec_json and returns it", () => {
    const svc = createMessagesService(freshDb());
    const saved = svc.appendMessage({
      role: "assistant",
      contentText: "记好了",
      specJson: '{"root":"a"}',
    });
    expect(saved.spec_json).toBe('{"root":"a"}');
    expect(svc.listMessages({ limit: 10 })[0].spec_json).toBe('{"root":"a"}');
  });
});

describe("GET /api/messages", () => {
  it("returns items oldest-first for the initial load", async () => {
    const db = freshDb();
    const svc = createMessagesService(db);
    for (const t of ["甲", "乙", "丙"]) svc.appendMessage({ role: "user", contentText: t });

    const res = await request(createApp({ db })).get("/api/messages");
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { content_text: string }) => m.content_text)).toEqual([
      "甲",
      "乙",
      "丙",
    ]);
  });

  it("pages older messages ascending with before_id", async () => {
    const db = freshDb();
    const svc = createMessagesService(db);
    for (const t of ["1", "2", "3", "4", "5"]) {
      svc.appendMessage({ role: "user", contentText: t });
    }
    const third = svc.listMessages({ limit: 10 }).find((m) => m.content_text === "3")!;

    const res = await request(createApp({ db })).get(
      `/api/messages?before_id=${third.id}&limit=2`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { content_text: string }) => m.content_text)).toEqual([
      "1",
      "2",
    ]);
  });
});
