/**
 * RoomDO — one Durable Object per chat room.
 *
 * Holds:
 *   - room metadata (name, creator, created_at)
 *   - the room's append-only message log (one row per user message)
 *   - the set of agent threads spawned from `@persona` mentions
 *
 * Built on `partyserver` so WebSocket fanout to connected clients is just
 * `this.broadcast(...)`. Hibernation is on — workerd evicts the DO when
 * idle and the WS reconnects pick up where they left off.
 *
 * Surface (mounted by the worker at `/api/rooms/:id/...`):
 *   POST /init           { id, name, createdBy }  — first-call only
 *   GET  /meta                                    — 404 before init
 *   GET  /messages                                — chronological list
 *   POST /messages       { parts }                — append; may mint a thread
 *   GET  /threads                                 — list of thread rows
 *
 * Identity is read from `x-user-*` headers the worker attaches; the DO
 * trusts the worker.
 */

import { Server } from "partyserver";
import { requireIdentity } from "./identity.js";
import { firstMention } from "./mentions.js";
import type { Author, AppMessage, RoomMeta, ThreadRow } from "@app/shared";



// Re-export the wire types so existing imports from "./room-do" keep working.
// The canonical definitions live in @app/shared.
export type { Author, AppMessage, RoomMeta, ThreadRow } from "@app/shared";

interface InitBody { id?: unknown; name?: unknown; createdBy?: unknown }
interface PostBody { parts?: unknown }

export class RoomDO extends Server<Env> {
  // Enable hibernation so the DO unloads while idle but WS connections survive.
  static options = { hibernate: true };

  /** Schema setup runs on every DO start (workerd may evict & re-create us). */
  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS room_meta (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      role        TEXT NOT NULL,
      parts_json  TEXT NOT NULL,
      author_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      thread_id   TEXT
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS threads (
      id              TEXT PRIMARY KEY,
      root_message_id TEXT NOT NULL,
      persona_id      TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    )`;
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // /init is a side-channel call from AppDO (worker-attributed). Identity is
    // still required so we record who initialized the room.
    if (request.method === "POST" && url.pathname.endsWith("/init")) {
      return this.handleInit(request);
    }

    // Everything else requires the room to exist.
    const meta = this.loadMeta();

    if (request.method === "GET" && url.pathname.endsWith("/meta")) {
      if (!meta) return new Response("not found", { status: 404 });
      return Response.json(meta);
    }

    if (!meta) return new Response("room not initialized", { status: 404 });

    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      return Response.json({ messages: this.listMessages() });
    }
    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      return this.handlePostMessage(request);
    }
    if (request.method === "GET" && url.pathname.endsWith("/threads")) {
      return Response.json({ threads: this.listThreads() });
    }

    return new Response("not found", { status: 404 });
  }

  // ---- /init ----

  private async handleInit(request: Request): Promise<Response> {
    const identityOrResp = requireIdentity(request);
    if (identityOrResp instanceof Response) return identityOrResp;

    const body = await request.json().catch(() => ({})) as InitBody;
    const id        = typeof body.id        === "string" ? body.id        : "";
    const name      = typeof body.name      === "string" ? body.name      : "";
    const createdBy = typeof body.createdBy === "string" ? body.createdBy : "";
    if (!id || !name || !createdBy) {
      return Response.json({ error: "id, name, createdBy required" }, { status: 400 });
    }

    if (this.loadMeta()) {
      return Response.json({ error: "already initialized" }, { status: 409 });
    }

    const createdAt = Date.now();
    this.sql`INSERT INTO room_meta(id, name, created_by, created_at)
             VALUES (${id}, ${name}, ${createdBy}, ${createdAt})`;
    return Response.json({ ok: true }, { status: 201 });
  }

  // ---- /messages ----

  private async handlePostMessage(request: Request): Promise<Response> {
    const identity = requireIdentity(request);
    if (identity instanceof Response) return identity;
    const body = await request.json().catch(() => ({})) as PostBody;

    const parts = sanitizeParts(body.parts);
    if (!parts) {
      return Response.json({ error: "parts must contain at least one non-empty text part" }, { status: 400 });
    }

    const text       = parts.map(p => p.text).join("\n");
    const mentioned  = firstMention(text);
    const messageId  = crypto.randomUUID();
    const createdAt  = Date.now();
    const author: Author = {
      kind:  "user",
      id:    identity.userId,
      email: identity.email,
      name:  identity.name,
    };

    // Mint a thread row if a known persona was mentioned. We mint at most one
    // thread per message — multiple `@persona` mentions collapse into a single
    // combined thread (per product requirements).
    let threadId: string | undefined;
    if (mentioned) {
      threadId = crypto.randomUUID();
      this.sql`INSERT INTO threads(id, root_message_id, persona_id, created_at)
               VALUES (${threadId}, ${messageId}, ${mentioned}, ${createdAt})`;
    }

    const message: AppMessage = {
      id:    messageId,
      role:  "user",
      parts,
      metadata: { author, createdAt, threadId },
    };
    this.sql`INSERT INTO messages(id, role, parts_json, author_json, created_at, thread_id)
             VALUES (${message.id}, ${message.role},
                     ${JSON.stringify(message.parts)},
                     ${JSON.stringify(message.metadata.author)},
                     ${createdAt}, ${threadId ?? null})`;
    // Fan out to WS subscribers so other clients see the message live.
    this.broadcast(JSON.stringify({ type: "message", message }));

    // Seed the Agent DO when a thread was minted. The thread id is also the
    // Agent DO id, so the client can connect to the same DO later.
    if (threadId && mentioned) {
      const meta = this.loadMeta();
      const seedBody = {
        personaId: mentioned,
        roomId:    meta?.id ?? "",
        threadId,
        message,
      };
      const agentStub = this.env.Agent.get(this.env.Agent.idFromName(threadId));
      // Inline-await so the thread is fully seeded before the client gets
      // its threadId back — simpler than racing the client's navigation.
      // We still swallow errors so a hiccup in the Agent DO doesn't lose
      // the room message (which is already persisted).
      try {
        await agentStub.fetch(new Request("https://agent/seed", {
          method:  "POST",
          headers: { "content-type": "application/json" },
          body:    JSON.stringify(seedBody),
        }));
      } catch { /* swallow */ }
    }

    return Response.json({ message, threadId }, { status: 201 });
  }

  // ---- queries ----

  private loadMeta(): RoomMeta | null {
    const rows = this.sql<{
      id: string; name: string; created_by: string; created_at: number;
    }>`SELECT id, name, created_by, created_at FROM room_meta LIMIT 1`;
    const r = rows[0];
    return r ? { id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at } : null;
  }

  private listMessages(): AppMessage[] {
    const rows = this.sql<{
      id: string; role: string; parts_json: string; author_json: string;
      created_at: number; thread_id: string | null;
    }>`SELECT id, role, parts_json, author_json, created_at, thread_id
       FROM messages ORDER BY created_at ASC, id ASC LIMIT 500`;
    return rows.map(r => ({
      id:    r.id,
      role:  r.role as "user" | "assistant",
      parts: JSON.parse(r.parts_json),
      metadata: {
        author:    JSON.parse(r.author_json),
        createdAt: r.created_at,
        threadId:  r.thread_id ?? undefined,
      },
    }));
  }

  private listThreads(): ThreadRow[] {
    const rows = this.sql<{
      id: string; root_message_id: string; persona_id: string; created_at: number;
    }>`SELECT id, root_message_id, persona_id, created_at
       FROM threads ORDER BY created_at ASC`;
    return rows.map(r => ({
      id:            r.id,
      rootMessageId: r.root_message_id,
      personaId:     r.persona_id,
      createdAt:     r.created_at,
    }));
  }
}

// ---- pure helpers ----

/**
 * Validate and normalize a parts array from the wire. Returns null if there
 * are no non-empty text parts (which we treat as "empty message").
 */
function sanitizeParts(raw: unknown): Array<{ type: "text"; text: string }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ type: "text"; text: string }> = [];
  for (const part of raw) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type !== "text" || typeof p.text !== "string") continue;
    const text = p.text.trim();
    if (!text) continue;
    out.push({ type: "text", text });
  }
  return out.length ? out : null;
}


