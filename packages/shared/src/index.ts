/**
 * Shared wire types between @app/agent (Worker + Durable Objects) and
 * @app/frontend (browser client).
 *
 * Keep this package free of runtime imports — types only. The agent code
 * re-exports these so existing call sites don't change.
 */

// ---- author / identity ----

/** Author stamp on user messages. Mirrors the Agent DO's ChatAuthor shape. */
export interface ChatAuthor {
  kind:  "user";
  id:    string;
  email: string;
  name:  string;
}

/** Author shape that may appear in room/thread message metadata. */
export type Author =
  | { kind: "user";  id: string; email: string; name: string }
  | { kind: "agent"; personaId: string; name: string };

/** What `GET /api/app/me` returns. */
export interface Me {
  userId: string;
  email:  string;
  name:   string;
  /** Human-readable label for the model currently in use. Display-only. */
  model:  string;
}

// ---- messages / rooms / threads ----

/**
 * Unified message shape used by both rooms (user-only) and threads
 * (users + agent). Mirrors the AI SDK's UIMessage just enough that the
 * Agent DO can persist it via `saveMessages()`.
 */
export interface AppMessage {
  id:       string;
  role:     "user" | "assistant";
  parts:    Array<{ type: "text"; text: string }>;
  metadata: {
    author:    Author;
    createdAt: number;
    /** Set on the room message that kicked off this thread (if any). */
    threadId?: string;
  };
}

export interface RoomMeta {
  id:        string;
  name:      string;
  createdBy: string;
  createdAt: number;
}

export interface RoomSummary {
  id:        string;
  name:      string;
  createdBy: string;
  createdAt: number;
}

export interface ThreadRow {
  id:            string;
  rootMessageId: string;
  personaId:     string;
  createdAt:     number;
}
