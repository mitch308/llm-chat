import type Database from "better-sqlite3";

export interface Message {
  id: number;
  role: "user" | "assistant";
  content_text: string;
  spec_json: string | null;
  created_at: string;
}

export interface MessagesService {
  /** 按 id 降序（新→旧）；beforeId 取比它更早（id 更小）、afterId 取比它更新（id 更大）的消息。 */
  listMessages(opts: { beforeId?: number; afterId?: number; limit?: number }): Message[];
  appendMessage(input: {
    role: "user" | "assistant";
    contentText: string;
    specJson?: string | null;
  }): Message;
}

export function createMessagesService(db: Database.Database): MessagesService {
  const listStmt = db.prepare(
    `SELECT * FROM messages
     WHERE (@beforeId IS NULL OR id < @beforeId)
       AND (@afterId IS NULL OR id > @afterId)
     ORDER BY id DESC
     LIMIT @limit`,
  );
  const appendStmt = db.prepare(
    `INSERT INTO messages (role, content_text, spec_json)
     VALUES (@role, @contentText, @specJson)
     RETURNING *`,
  );

  return {
    listMessages({ beforeId, afterId, limit = 100 }) {
      const capped = Math.min(Math.max(1, limit), 200);
      return listStmt.all({ beforeId: beforeId ?? null, afterId: afterId ?? null, limit: capped }) as Message[];
    },
    appendMessage({ role, contentText, specJson = null }) {
      return appendStmt.get({
        role,
        contentText,
        specJson,
      }) as Message;
    },
  };
}
