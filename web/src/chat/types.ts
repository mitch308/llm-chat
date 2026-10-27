/** 与服务端 AgentEvent 协议对齐（server/src/agent/agent.ts）。 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "spec"; line: string }
  | { type: "tool"; name: string }
  | { type: "done"; message?: { id: number } }
  | { type: "error"; message: string };

export interface ChatMsg {
  id?: number;
  role: "user" | "assistant";
  text: string;
  specLines: string[];
}

export interface ServerMessage {
  id: number;
  role: "user" | "assistant";
  content_text: string;
  spec_json: string | null;
  created_at: string;
}
