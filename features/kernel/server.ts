import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/vue";
import type Database from "better-sqlite3";
import type { Router } from "express";
import { z, type ZodType } from "zod";

// ---- wire 类型唯一定义处（server/src/chat/llm.ts 从此处 re-export 以兼容旧导入路径）----

/** 模型侧工具调用（arguments 为 JSON 字符串）。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 与 OpenAI 兼容格式的工具定义。 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** 多轮对话消息（agent 循环回喂用）。 */
export interface ModelMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type Delta =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export interface LLMClient {
  stream(input: {
    system: string;
    messages: ModelMsg[];
    tools: ToolDef[];
  }): AsyncIterable<Delta>;
}

export type RunResult =
  | { ok: true; data: object }
  | { ok: false; code: string; message: string };

export interface ToolEnv {
  db: Database.Database;
  llm?: LLMClient;
}

export interface ToolEntry {
  def: ToolDef;
  schema?: ZodType; // agent 入参校验（原 argSchemas 各业务段）
  execute(args: unknown, env: ToolEnv): Promise<unknown>;
}

/** 服务端直出确认卡片的输入：agent 循环在 propose_op/execute_op 成功后组装。 */
export interface OpCardInput {
  opId: string;
  kind: string;
  status: "pending" | "executed";
  payload: Record<string, unknown>;
  /** status="executed" 时的执行结果 data（如 {bill}）；pending 时为 null。 */
  data: Record<string, unknown> | null;
}

/** 直出卡片的组件声明（type 须在 catalog 注册，props 由 feature 按 shared 契约构造）。 */
export interface OpCardComponent {
  type: string;
  props: Record<string, unknown>;
}

export interface OpHandler {
  argPayload: ZodType; // propose_op 的 payload 校验（按 kind 查）
  execute(
    payload: Record<string, unknown>,
    env: ToolEnv,
  ): Promise<RunResult> | RunResult;
  afterExecute?(env: ToolEnv & { opId: string }, data: object): void; // 写结果 + quip 等后置
  cardHint?: { created: string; duplicate: string }; // 回退用：无 cardSpec 时 propose_op 两条回喂的 spec 卡片指令
  /** 服务端直出确认卡片：propose_op/execute_op 成功后由 agent 循环直接产出 spec 并收尾回合，
   *  不再消耗模型轮次（LLM 调用准则：服务端已确定的内容不消耗模型轮次）。
   *  返回 null（或未提供）时回退 cardHint，由模型出卡片。 */
  cardSpec?(input: OpCardInput, env: ToolEnv): OpCardComponent | null;
}

/** 直出卡片的 spec JSONL 行（/root + /elements/confirm-card，与模型手写格式一致）。 */
export function confirmCardLines(card: OpCardComponent): string[] {
  return [
    JSON.stringify({ op: "add", path: "/root", value: "confirm-card" }),
    JSON.stringify({
      op: "add",
      path: "/elements/confirm-card",
      value: { type: card.type, props: card.props, children: [] },
    }),
  ];
}

export interface CatalogComponentDef {
  props: ZodType;
  description: string;
}
export interface CatalogActionDef {
  params: ZodType;
  description: string;
}
export interface SkillSection {
  intent: string;
  label: string;
  hint: string;
  body: string;
}

export interface ServerFeatureContext {
  ddl(stmt: string | string[]): void;
  ddlOptional(stmt: string): void; // 执行失败仅记录（FTS5 降级）
  seed(run: (db: Database.Database) => void): void;
  // llm 为可选线程：需要模型能力的 REST 路由（如 news 的翻译/摘要）经此透传给 service
  route(fn: (db: Database.Database, llm?: LLMClient) => Router): void;
  tool(
    def: ToolDef,
    opts: {
      schema?: ZodType;
      execute(args: unknown, env: ToolEnv): Promise<unknown>;
    },
  ): void;
  catalogComponents(defs: Record<string, CatalogComponentDef>): void;
  catalogActions(defs: Record<string, CatalogActionDef>): void;
  skill(section: SkillSection): void;
  ops(kinds: string[], handler: OpHandler): void;
}

export interface ServerFeature {
  name: string;
  register(ctx: ServerFeatureContext): void;
}

export interface AssembledServer {
  ddl: string[];
  ddlOptional: string[];
  seedFns: ((db: Database.Database) => void)[];
  routers: ((db: Database.Database, llm?: LLMClient) => Router)[];
  tools: Map<string, ToolEntry>;
  catalog: ReturnType<typeof defineCatalog>; // defineCatalog(schema, {components, actions}) 的合并结果
  skills: SkillSection[];
  ops: Map<string, OpHandler>;
}

/** 声明一个 server feature（目录约定 features/<name>/server/index.ts 的 default 导出）。 */
export function defineServerFeature(
  name: string,
  register: (ctx: ServerFeatureContext) => void,
): ServerFeature {
  return { name, register };
}

/** 键冲突 fail-fast：重复注册直接抛错（Review Focus 4）。 */
function assertKeyFree(
  owner: string,
  kind: string,
  key: string,
  taken: (k: string) => boolean,
): void {
  if (taken(key)) {
    throw new Error(`${kind} 冲突: ${key}（feature ${owner} 重复注册）`);
  }
}

/**
 * 按传入顺序调用各 feature 的 register，汇总成服务端装配产物。
 * catalog 内置一条核心 action cancel_op（ops 是核心设施，不属任何 feature）。
 */
export function assembleServerFeatures(features: ServerFeature[]): AssembledServer {
  const ddl: string[] = [];
  const ddlOptional: string[] = [];
  const seedFns: ((db: Database.Database) => void)[] = [];
  const routers: ((db: Database.Database, llm?: LLMClient) => Router)[] = [];
  const tools = new Map<string, ToolEntry>();
  const components: Record<string, CatalogComponentDef> = {};
  const actions: Record<string, CatalogActionDef> = {
    cancel_op: {
      params: z.object({ op_id: z.string() }),
      description: "取消当前提议",
    },
  };
  const skills: SkillSection[] = [];
  const ops = new Map<string, OpHandler>();

  for (const feature of features) {
    feature.register({
      ddl: (stmt) => ddl.push(...(Array.isArray(stmt) ? stmt : [stmt])),
      ddlOptional: (stmt) => ddlOptional.push(stmt),
      seed: (run) => seedFns.push(run),
      route: (fn) => routers.push(fn),
      tool: (def, opts) => {
        const name = def.function.name;
        assertKeyFree(feature.name, "tool", name, (k) => tools.has(k));
        tools.set(name, { def, schema: opts.schema, execute: opts.execute });
      },
      catalogComponents: (defs) => {
        for (const [key, def] of Object.entries(defs)) {
          assertKeyFree(feature.name, "catalog component", key, (k) => k in components);
          components[key] = def;
        }
      },
      catalogActions: (defs) => {
        for (const [key, def] of Object.entries(defs)) {
          assertKeyFree(feature.name, "catalog action", key, (k) => k in actions);
          actions[key] = def;
        }
      },
      skill: (section) => skills.push(section),
      ops: (kinds, handler) => {
        for (const kind of kinds) {
          assertKeyFree(feature.name, "op kind", kind, (k) => ops.has(k));
          ops.set(kind, handler);
        }
      },
    });
  }

  return {
    ddl,
    ddlOptional,
    seedFns,
    routers,
    tools,
    catalog: defineCatalog(schema, { components, actions }),
    skills,
    ops,
  };
}

/**
 * 扫描 feature 目录：过滤存在 server/index.ts 的子目录，
 * 按目录名排序后逐个动态导入取 default 导出。顺序确定性是 DDL/技能顺序的保证。
 */
export async function scanServerFeatures(dirUrl: URL): Promise<ServerFeature[]> {
  const dir = fileURLToPath(dirUrl);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "server", "index.ts")))
    .map((e) => e.name)
    .sort();
  const features: ServerFeature[] = [];
  for (const name of names) {
    const mod = (await import(
      pathToFileURL(join(dir, name, "server", "index.ts")).href
    )) as { default: ServerFeature };
    features.push(mod.default);
  }
  return features;
}

/** 读取 op_proposals.result_json（{data, quip} 形状，替代原 ops.executor.storeResult）。 */
export function readOpResult(
  db: Database.Database,
  opId: string,
): { data?: object; quip?: string | null } {
  const row = db
    .prepare(`SELECT result_json FROM op_proposals WHERE op_id = ?`)
    .get(opId) as { result_json: string | null } | undefined;
  if (!row?.result_json) return {};
  try {
    return JSON.parse(row.result_json) as { data?: object; quip?: string | null };
  } catch {
    return {}; // 存量结果不可解析：宁缺勿错
  }
}

/** 把执行结果（含 quip）写回提议。 */
export function writeOpResult(
  db: Database.Database,
  opId: string,
  data: object,
  quip: string | null,
): void {
  db.prepare(`UPDATE op_proposals SET result_json = ? WHERE op_id = ?`).run(
    JSON.stringify({ data, quip }),
    opId,
  );
}

// ---- FTS5 旗标（原 db/connection.ts 模块态，news.service 消费）----

let fts5Enabled = false;

export function isFts5Enabled(): boolean {
  return fts5Enabled;
}

export function setFts5Enabled(v: boolean): void {
  fts5Enabled = v;
}
