import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllForTests, getDb } from "../db/connection";
import { createMessagesService } from "../messages/messages.service";
import { createApp } from "../app";
import { createFakeLLM } from "./llm";
import { createSpecSplitter } from "./streamSplitter";

let dirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-chat-chat-"));
  dirs.push(dir);
  return getDb(path.join(dir, "test.db"));
}

afterEach(() => {
  closeAllForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("createSpecSplitter", () => {
  it("splits text from a JSONL spec line split across chunks", () => {
    const sp = createSpecSplitter();
    const events1 = [...sp.feed("你好\n{\"op\":\"add\",")];
    const events2 = [...sp.feed("\"path\":\"/root\"}\n")];

    expect(events1).toEqual([{ kind: "text", delta: "你好\n" }]);
    expect(events2).toEqual([{ kind: "spec", line: '{"op":"add","path":"/root"}' }]);
  });

  it("strips code fence lines", () => {
    const sp = createSpecSplitter();
    const events = [...sp.feed("```\n{\"op\":\"add\",\"path\":\"/root\"}\n```\n")];
    expect(events).toEqual([{ kind: "spec", line: '{"op":"add","path":"/root"}' }]);
  });

  it("flushes a trailing partial text line on end()", () => {
    const sp = createSpecSplitter();
    expect([...sp.feed("还没写完")]).toEqual([]);
    const flushed = sp.end();
    expect(flushed).toEqual([{ kind: "text", delta: "还没写完" }]);
  });
});

describe("POST /api/chat (text-only v1)", () => {
  it("streams SSE text events and persists user+assistant messages", async () => {
    const db = freshDb();
    const llm = createFakeLLM([
      [
        { type: "text", delta: "记" },
        { type: "text", delta: "好了" },
      ],
    ]);
    const app = createApp({ db, llm });

    const res = await request(app)
      .post("/api/chat")
      .send({ content: "今天买衣服花了200" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = res.text
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.delta).join("")).toBe("记好了");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(typeof (done as { message?: { id: number } }).message?.id).toBe("number");

    const svc = createMessagesService(db);
    const saved = svc.listMessages({ limit: 10 });
    expect(saved).toHaveLength(2);
    expect(saved[1].role).toBe("user");
    expect(saved[1].content_text).toBe("今天买衣服花了200");
    expect(saved[0].role).toBe("assistant");
    expect(saved[0].content_text).toBe("记好了");
    expect(saved[0].id).toBe((done as { message: { id: number } }).message.id);
  });

  it("rejects empty content with 400", async () => {
    const db = freshDb();
    const app = createApp({ db, llm: createFakeLLM([]) });
    const res = await request(app).post("/api/chat").send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("returns readable JSON error when no API key is configured", async () => {
    const prev = process.env.ZHIPU_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    try {
      const db = freshDb();
      const app = createApp({ db }); // 无注入 llm → 真实客户端 → 无 key
      const res = await request(app).post("/api/chat").send({ content: "hi" });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("NO_API_KEY");
      expect(res.body.message).toContain("ZHIPU_API_KEY");
    } finally {
      if (prev !== undefined) process.env.ZHIPU_API_KEY = prev;
    }
  });
});
