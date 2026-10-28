import type Database from "better-sqlite3";
import { Router } from "express";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  assembleServerFeatures,
  defineServerFeature,
  isFts5Enabled,
  readOpResult,
  scanServerFeatures,
  setFts5Enabled,
  writeOpResult,
  type OpHandler,
} from "@llm-chat/features/server";

const toolDef = (name: string) => ({
  type: "function" as const,
  function: { name, description: `工具 ${name}`, parameters: { type: "object", properties: {} } },
});

describe("assembleServerFeatures", () => {
  it("按注册顺序收集 ddl（数组与单条混用）/seed/skill/route，tool 按 def 名建索引", () => {
    const router = Router();
    const featureA = defineServerFeature("a", (ctx) => {
      ctx.ddl(["CREATE TABLE a1 (id INTEGER)", "CREATE TABLE a2 (id INTEGER)"]);
      ctx.seed(() => {});
      ctx.skill({ intent: "记账", label: "记账", hint: "用户想记账", body: "调用记账工具" });
      ctx.route(() => router);
      ctx.tool(toolDef("tool_a"), { execute: async () => null });
    });
    const featureB = defineServerFeature("b", (ctx) => {
      ctx.ddl("CREATE TABLE b1 (id INTEGER)");
      ctx.tool(toolDef("tool_b"), { execute: async () => null });
    });

    const assembled = assembleServerFeatures([featureA, featureB]);

    expect(assembled.ddl).toEqual([
      "CREATE TABLE a1 (id INTEGER)",
      "CREATE TABLE a2 (id INTEGER)",
      "CREATE TABLE b1 (id INTEGER)",
    ]);
    expect(assembled.seedFns).toHaveLength(1);
    expect(assembled.skills.map((s) => s.intent)).toEqual(["记账"]);
    // route 注册的是 Router 工厂：拿到 db 才产出 Router 实例
    expect(assembled.routers).toHaveLength(1);
    expect(assembled.routers[0]({} as never)).toBe(router);
    expect([...assembled.tools.keys()]).toEqual(["tool_a", "tool_b"]);
  });

  it("两个 feature 注册同名 tool 时组装抛错（fail-fast）", () => {
    const featureA = defineServerFeature("a", (ctx) => {
      ctx.tool(toolDef("dup"), { execute: async () => null });
    });
    const featureB = defineServerFeature("b", (ctx) => {
      ctx.tool(toolDef("dup"), { execute: async () => null });
    });
    expect(() => assembleServerFeatures([featureA, featureB])).toThrow(/dup/);
  });

  it("catalog 合并 feature 定义，并内置核心 action cancel_op", () => {
    const feature = defineServerFeature("c", (ctx) => {
      ctx.catalogComponents({
        Foo: { props: z.object({ x: z.number() }), description: "测试组件" },
      });
      ctx.catalogActions({
        foo_do: { params: z.object({ op_id: z.string() }), description: "测试动作" },
      });
    });
    const assembled = assembleServerFeatures([feature]);
    expect(assembled.catalog.componentNames).toContain("Foo");
    expect(assembled.catalog.actionNames).toContain("foo_do");
    expect(assembled.catalog.actionNames).toContain("cancel_op");
  });

  it("catalog 组件/action 键冲突同样抛错", () => {
    const componentClash = [
      defineServerFeature("a", (ctx) => {
        ctx.catalogComponents({ Dup: { props: z.object({}), description: "a" } });
      }),
      defineServerFeature("b", (ctx) => {
        ctx.catalogComponents({ Dup: { props: z.object({}), description: "b" } });
      }),
    ];
    expect(() => assembleServerFeatures(componentClash)).toThrow(/Dup/);

    const actionClash = [
      defineServerFeature("a", (ctx) => {
        ctx.catalogActions({ dup_act: { params: z.object({}), description: "a" } });
      }),
      defineServerFeature("b", (ctx) => {
        ctx.catalogActions({ dup_act: { params: z.object({}), description: "b" } });
      }),
    ];
    expect(() => assembleServerFeatures(actionClash)).toThrow(/dup_act/);

    // 内置 cancel_op 同样受保护：feature 不得覆盖核心 action
    const builtinClash = [
      defineServerFeature("a", (ctx) => {
        ctx.catalogActions({ cancel_op: { params: z.object({}), description: "覆盖内置" } });
      }),
    ];
    expect(() => assembleServerFeatures(builtinClash)).toThrow(/cancel_op/);
  });

  it("ops 按 kind 注册可查", () => {
    const handler: OpHandler = {
      argPayload: z.object({ op_id: z.string() }),
      execute: () => ({ ok: true, data: {} }),
    };
    const feature = defineServerFeature("o", (ctx) => {
      ctx.ops(["bill_create", "bill_update"], handler);
    });
    const assembled = assembleServerFeatures([feature]);
    expect(assembled.ops.size).toBe(2);
    expect(assembled.ops.get("bill_create")).toBe(handler);
    expect(assembled.ops.get("bill_update")).toBe(handler);
  });

  it("两个 feature 注册重叠 kind 时抛错（fail-fast）", () => {
    const handler: OpHandler = { argPayload: z.object({}), execute: () => ({ ok: true, data: {} }) };
    const featureA = defineServerFeature("a", (ctx) => ctx.ops(["bill_create"], handler));
    const featureB = defineServerFeature("b", (ctx) => ctx.ops(["bill_create"], handler));
    expect(() => assembleServerFeatures([featureA, featureB])).toThrow(/bill_create/);
  });
});

describe("scanServerFeatures", () => {
  it("扫描目录下含 server/index.ts 的 feature，按目录名排序，取 default 导出", async () => {
    const features = await scanServerFeatures(new URL("./__fixtures__/", import.meta.url));
    expect(features.map((f) => f.name)).toEqual(["demo"]);
    // 扫描结果可直接进入组装
    const assembled = assembleServerFeatures(features);
    expect(assembled.ddl).toEqual(["SELECT 1"]);
  });
});

describe("op 结果读写与 FTS5 旗标", () => {
  it("writeOpResult/readOpResult 以 {data, quip} 形状读写 result_json（mock db，不触真库）", () => {
    const stmt = { run: vi.fn(), get: vi.fn() };
    const prepare = vi.fn(() => stmt);
    const db = { prepare } as unknown as Database.Database;

    writeOpResult(db, "op_1", { id: 1 }, "记好啦");
    expect(prepare).toHaveBeenCalledWith(
      `UPDATE op_proposals SET result_json = ? WHERE op_id = ?`,
    );
    expect(stmt.run).toHaveBeenCalledWith(
      JSON.stringify({ data: { id: 1 }, quip: "记好啦" }),
      "op_1",
    );

    stmt.get.mockReturnValue({ result_json: JSON.stringify({ data: { id: 1 }, quip: "记好啦" }) });
    expect(readOpResult(db, "op_1")).toEqual({ data: { id: 1 }, quip: "记好啦" });

    stmt.get.mockReturnValue(undefined);
    expect(readOpResult(db, "missing")).toEqual({});

    stmt.get.mockReturnValue({ result_json: "not-json" });
    expect(readOpResult(db, "bad")).toEqual({});
  });

  it("FTS5 旗标模块态可读写", () => {
    expect(isFts5Enabled()).toBe(false);
    setFts5Enabled(true);
    expect(isFts5Enabled()).toBe(true);
    setFts5Enabled(false);
    expect(isFts5Enabled()).toBe(false);
  });
});
