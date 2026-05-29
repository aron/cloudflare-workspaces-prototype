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
  | { kind: "agent"; id: string;    name: string };

/** What `GET /api/app/me` returns. */
export interface Me {
  userId: string;
  email:  string;
  name:   string;
  /** Human-readable label for the model currently in use. Display-only. */
  model:  string;
}

/**
 * Public-facing summary of a known user. Anyone who has signed in once is
 * recorded by the App DO and may show up in mention autocomplete.
 *
 * `username` is the bit before the `@` of `email`, lowercased and stripped
 * of anything outside `[a-z0-9._-]` — stable, display-only, never sent back
 * to the server as an identifier.
 */
export interface UserSummary {
  id:        string;
  email:     string;
  name:      string;
  username:  string;
  lastSeen:  number;
}

/** Per-user settings owned by the signed-in user. */
export interface UserSettings {
  /** Numeric Google Workspace user ID (digits only), or null when unset. */
  googleChatUserId: string | null;
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
  /** Stable identifier of the agent that owns the thread. Always "agent" for v1. */
  agentId:       string;
  createdAt:     number;
}
