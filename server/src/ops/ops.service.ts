import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/** kind 泛化为自由字符串（注册表 ASM.ops 为权威；DDL 已放开 kind 列 CHECK）。 */
export type OpKind = string;
export type OpStatus = "pending" | "executed" | "cancelled" | "expired";

export interface OpProposal {
  op_id: string;
  kind: OpKind;
  payload_json: string;
  status: OpStatus;
  result_json: string | null;
  created_at: string;
  executed_at: string | null;
}

export type RunResult =
  | { ok: true; data: object }
  | { ok: false; code: string; message: string };

export type ExecOutcome =
  | { status: "executed"; data: object }
  | { status: "already"; data: object }
  | { status: "invalid"; reason: "not_found" | "expired" | "cancelled"; message: string };

/** 最近提议摘要：供系统提示注入权威状态（按钮/文字两条确认路径共用同一状态机）。 */
export interface OpStatusSummary {
  op_id: string;
  kind: OpKind;
  status: OpStatus;
  created_at: string;
  payload: Record<string, unknown>;
}

const TTL_MS = 10 * 60 * 1000;

export interface OpsService {
  proposeOp(kind: OpKind, payload: object): OpProposal;
  executeOp(
    opId: string,
    run: (payload: Record<string, unknown>) => Promise<RunResult>,
  ): Promise<ExecOutcome>;
  cancelOp(opId: string): void;
  getOps(opIds: string[]): OpProposal[];
  /** 最近 N 条提议（新→旧），status 经 TTL 修正 */
  getRecentOpsSummary(limit?: number): OpStatusSummary[];
}

/**
 * 提议生命周期：服务端发号；全局同时最多 1 个 pending（新提议取代旧提议）；
 * 幂等（executed 重放返回首次结果）；TTL 过期服务端强制；run 抛异常/返回 ok:false
 * 时保持 pending 可重试。
 */
export function createOpsService(
  db: Database.Database,
  opts: { now?: () => Date; ttlMs?: number } = {},
): OpsService {
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? TTL_MS;

  /** TTL 已过但尚未被触碰的 pending，对外一律呈现 expired：
   *  TTL 不只在 executeOp 强制——读路径（卡片状态核对 getOps、系统提示 getRecentOpsSummary）
   *  同样按 TTL 呈现，避免把死提议喂给模型或让旧卡片保持可点。 */
  function effectiveStatus(row: OpProposal): OpStatus {
    if (
      row.status === "pending" &&
      now().getTime() - new Date(row.created_at).getTime() > ttlMs
    ) {
      return "expired";
    }
    return row.status;
  }

  const insert = db.prepare(
    `INSERT INTO op_proposals (op_id, kind, payload_json, status, created_at)
     VALUES (?, ?, ?, 'pending', ?) RETURNING *`,
  );
  const getById = db.prepare(`SELECT * FROM op_proposals WHERE op_id = ?`);
  const supersedePending = db.prepare(
    // 用户切换到新账单 = 放弃当前确认，旧 pending 标记 cancelled（而非 expired）
    `UPDATE op_proposals SET status = 'cancelled' WHERE status = 'pending'`,
  );
  const markFinal = db.prepare(
    `UPDATE op_proposals SET status = ?, result_json = ?, executed_at = ?
     WHERE op_id = ?`,
  );

  function proposeOp(kind: OpKind, payload: object): OpProposal {
    const ts = now().toISOString();
    const run = db.transaction(() => {
      supersedePending.run();
      return insert.get(randomUUID(), kind, JSON.stringify(payload), ts) as OpProposal;
    });
    return run();
  }

  async function executeOp(
    opId: string,
    run: (payload: Record<string, unknown>) => Promise<RunResult>,
  ): Promise<ExecOutcome> {
    const row = getById.get(opId) as OpProposal | undefined;
    if (!row) {
      return { status: "invalid", reason: "not_found", message: "提议不存在" };
    }
    if (row.status === "executed") {
      const stored = JSON.parse(row.result_json ?? "{}") as { data?: object };
      return { status: "already", data: stored.data ?? {} };
    }
    if (row.status === "expired") {
      return { status: "invalid", reason: "expired", message: "提议已过期，请重新发起" };
    }
    if (row.status === "cancelled") {
      return { status: "invalid", reason: "cancelled", message: "提议已取消" };
    }

    // pending：先查 TTL
    if (now().getTime() - new Date(row.created_at).getTime() > ttlMs) {
      markFinal.run("expired", null, null, opId);
      return { status: "invalid", reason: "expired", message: "提议已过期，请重新发起" };
    }

    const result = await run(JSON.parse(row.payload_json) as Record<string, unknown>);
    if (!result.ok) {
      // 业务失败：保持 pending 允许重试，把可读错误抛给上层映射 HTTP
      throw new OpRunError(result.code, result.message);
    }
    markFinal.run("executed", JSON.stringify({ data: result.data }), now().toISOString(), opId);
    return { status: "executed", data: result.data };
  }

  function cancelOp(opId: string): void {
    db.prepare(
      `UPDATE op_proposals SET status = 'cancelled' WHERE op_id = ? AND status = 'pending'`,
    ).run(opId);
  }

  function getOps(opIds: string[]): OpProposal[] {
    if (opIds.length === 0) return [];
    const placeholders = opIds.map(() => "?").join(",");
    return db
      .prepare(`SELECT * FROM op_proposals WHERE op_id IN (${placeholders})`)
      .all(...opIds)
      .map((row: unknown) => {
        const r = row as OpProposal;
        return { ...r, status: effectiveStatus(r) };
      });
  }

  function getRecentOpsSummary(limit = 5): OpStatusSummary[] {
    const rows = db
      .prepare(`SELECT * FROM op_proposals ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as unknown as OpProposal[];
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        // 坏 payload 容忍：只影响摘要内容，不影响状态
      }
      return {
        op_id: row.op_id,
        kind: row.kind,
        status: effectiveStatus(row),
        created_at: row.created_at,
        payload,
      };
    });
  }

  return { proposeOp, executeOp, cancelOp, getOps, getRecentOpsSummary };
}

/** run 返回 ok:false 时抛出，供路由层映射 HTTP 错误。 */
export class OpRunError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpRunError";
  }
}
