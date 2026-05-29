/**
 * Room — one Durable Object per chat room.
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
import { shortId } from "./ids.js";
import { APP_DO_NAME } from "./app.js";
import {
  buildSnippet,
  extractMentionedUserIds,
  log,
  sendGChatMention,
} from "./notify.js";
import { resolveBaseUrl } from "./base-url.js";


/**
 * Triggers an agent thread when the message mentions the agent. Accepts
 * the canonical `<mention type="agent" id="...">@agent</mention>` token
 * (emitted by the composer's serializer) and the legacy bare `@agent`
 * literal (when the user types it raw without a known handle resolver).
 * Single-agent app: only one bot to address, so we don't parse ids.
 */
function hasAgentMention(text: string): boolean {
  if (/(^|\s)@agent(\b|$)/i.test(text)) return true;
  if (/<mention\s+type="agent"\s+id="[A-Za-z0-9._-]+"\s*>[^<]*<\/mention>/.test(text)) return true;
  return false;
}
import type { Author, AppMessage, RoomMeta, ThreadRow } from "@app/shared";



// Re-export the wire types so existing imports from "./room" keep working.
// The canonical definitions live in @app/shared.
export type { Author, AppMessage, RoomMeta, ThreadRow } from "@app/shared";

interface InitBody { id?: unknown; name?: unknown; createdBy?: unknown }
interface PostBody { parts?: unknown; clientId?: unknown }

export class Room extends Server<Env> {
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
      thread_id   TEXT,
      client_id   TEXT
    )`;
    // Migration for rooms that pre-date the client_id column. Done as a
    // conditional ALTER rather than try/catch around a duplicate-column
    // error so we don't trip partyserver's exception logger every startup.
    const cols = this.sql<{ name: string }>`PRAGMA table_info(messages)`;
    if (!cols.some(c => c.name === "client_id")) {
      this.sql`ALTER TABLE messages ADD COLUMN client_id TEXT`;
    }
    this.sql`CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at)`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id
             ON messages(client_id) WHERE client_id IS NOT NULL`;
    this.sql`CREATE TABLE IF NOT EXISTS threads (
      id              TEXT PRIMARY KEY,
      root_message_id TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    )`;
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // /init is a side-channel call from App (worker-attributed). Identity is
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
    // DELETE /threads/:id — detach the thread from the room. The thread
    // row goes away and the originating message has its thread_id nulled
    // (the message itself stays in the timeline). The Agent DO that backed
    // the thread is wiped by the worker.
    {
      const m = url.pathname.match(/^\/threads\/([^/]+)\/?$/);
      if (request.method === "DELETE" && m) {
        return this.handleDeleteThread(m[1]);
      }
    }

    // DELETE / — wipe the entire room (meta, messages, threads). The
    // worker calls this as part of /api/rooms/:id deletion; it then cleans
    // up the App registry and the per-thread Agent DOs.
    if (request.method === "DELETE" && (url.pathname === "/" || url.pathname === "")) {
      return this.handleDeleteRoom();
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
    const clientId = typeof body.clientId === "string" && body.clientId.length <= 128
      ? body.clientId
      : undefined;

    // Idempotent retry: if the client supplies a clientId we've already
    // seen, return the original row instead of inserting a duplicate. This
    // lets the browser safely retry POSTs across a deploy / network hiccup
    // without the room growing duplicate messages.
    if (clientId) {
      const existing = this.findByClientId(clientId);
      if (existing) {
        return Response.json(
          { message: existing, threadId: existing.metadata.threadId, deduped: true },
          { status: 200 },
        );
      }
    }

    const text         = parts.map(p => p.text).join("\n");
    const mintsThread  = hasAgentMention(text);
    const messageId    = shortId();
    const createdAt    = Date.now();
    const author: Author = {
      kind:  "user",
      id:    identity.userId,
      email: identity.email,
      name:  identity.name,
    };

    // Mint a thread row when the user @-mentions the agent. There's exactly
    // one agent persona in this app, so the thread's agent_id is always
    // "agent".
    let threadId: string | undefined;
    if (mintsThread) {
      threadId = shortId();
      this.sql`INSERT INTO threads(id, root_message_id, agent_id, created_at)
               VALUES (${threadId}, ${messageId}, ${"agent"}, ${createdAt})`;
    }

    const message: AppMessage = {
      id:    messageId,
      role:  "user",
      parts,
      metadata: { author, createdAt, threadId },
    };
    this.sql`INSERT INTO messages(id, role, parts_json, author_json, created_at, thread_id, client_id)
             VALUES (${message.id}, ${message.role},
                     ${JSON.stringify(message.parts)},
                     ${JSON.stringify(message.metadata.author)},
                     ${createdAt}, ${threadId ?? null}, ${clientId ?? null})`;
    // Fan out to WS subscribers so other clients see the message live.
    // Fan out to WS subscribers so other clients see the message live.
    // We include `clientId` on the broadcast (and POST response) so the
    // sender can match the live frame to its optimistic placeholder and
    // swap in the server-assigned id without rendering a duplicate.
    this.broadcast(JSON.stringify({ type: "message", message, clientId }));

    // Seed the Agent DO when a thread was minted. The thread id is also the
    // Agent DO id, so the client can connect to the same DO later.
    if (threadId && mintsThread) {
      const meta = this.loadMeta();
      const seedBody = {
        roomId:    meta?.id   ?? "",
        roomName:  meta?.name ?? "",
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

    // Fire @mention notifications via Google Chat webhook. Best-effort:
    // failures never block the message POST, and we always run inside
    // `waitUntil` so the network round-trip happens after the response.
    this.maybeNotifyMentions(message, identity.userId, request, threadId);

    return Response.json({ message, threadId, clientId }, { status: 201 });
  }

  // ---- mention notifications ----

  /**
   * Inspect a freshly-persisted message for `<user:ID>` tokens and POST a
   * Google Chat ping for each mentioned user that has a Google Chat ID on
   * file. No-op when `GCHAT_WEBHOOK_URL` isn't configured. Self-mentions
   * are skipped. All work runs under `ctx.waitUntil` so it doesn't extend
   * the request critical path.
   */
  private maybeNotifyMentions(
    message: AppMessage,
    authorUserId: string,
    request: Request,
    threadId: string | undefined,
  ): void {
    const webhookUrl = (this.env as { GCHAT_WEBHOOK_URL?: string }).GCHAT_WEBHOOK_URL;
    if (!webhookUrl) return;
    const text = message.parts.map(p => p.text).join("\n");
    const ids = extractMentionedUserIds(text).filter(id => id !== authorUserId);
    if (ids.length === 0) return;

    const meta = this.loadMeta();
    const roomName = meta?.name ?? "room";
    const roomId   = meta?.id ?? "";
    const snippet  = buildSnippet(text);

    // Build a deep-linking URL back to this specific message. Falls back to
    // omitting the URL when we don't have a base origin to anchor against —
    // bare paths are useless in Google Chat.
    const baseUrl = resolveBaseUrl(this.env, request);
    const roomUrl = baseUrl && roomId
      ? (threadId
        ? `${baseUrl}/rooms/${roomId}/threads/${threadId}#${message.id}`
        : `${baseUrl}/rooms/${roomId}#${message.id}`)
      : undefined;

    this.ctx.waitUntil((async () => {
      try {
        const appStub = this.env.App.get(this.env.App.idFromName(APP_DO_NAME));
        const res = await appStub.fetch(new Request("https://app/notify-lookup", {
          method:  "POST",
          headers: { "content-type": "application/json" },
          // No identity header: this is a DO-to-DO call. App.notify-lookup
          // is reached via the same `fetch` middleware, but identity is
          // required upstream; we hop in via a synthetic header set below.
          body:    JSON.stringify({ userIds: ids }),
        }));
        if (!res.ok) return;
        const body = await res.json() as {
          users: Array<{ userId: string; name: string; googleChatUserId: string | null }>;
        };
        await Promise.all(body.users.map(u => {
          if (!u.googleChatUserId) return;
          return sendGChatMention({
            webhookUrl,
            googleChatUserId: u.googleChatUserId,

            roomName,
            roomUrl,
            snippet,
          });
        }));
      } catch (e) {
        log("warn", "room notify-mentions failed", { error: (e as Error).message });
      }
    })());
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
       FROM messages ORDER BY created_at ASC, rowid ASC LIMIT 500`;
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

  /**
   * Look up a previously-posted message by the client-supplied dedup key.
   * Used by `handlePostMessage` to make POSTs idempotent across retries.
   * Returns null when no message has been posted under this key yet.
   */
  private findByClientId(clientId: string): AppMessage | null {
    const rows = this.sql<{
      id: string; role: string; parts_json: string; author_json: string;
      created_at: number; thread_id: string | null;
    }>`SELECT id, role, parts_json, author_json, created_at, thread_id
       FROM messages WHERE client_id = ${clientId} LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      id:    r.id,
      role:  r.role as "user" | "assistant",
      parts: JSON.parse(r.parts_json),
      metadata: {
        author:    JSON.parse(r.author_json),
        createdAt: r.created_at,
        threadId:  r.thread_id ?? undefined,
      },
    };
  }

  private listThreads(): ThreadRow[] {
    const rows = this.sql<{
      id: string; root_message_id: string; agent_id: string; created_at: number;
    }>`SELECT id, root_message_id, agent_id, created_at
       FROM threads ORDER BY created_at ASC`;
    return rows.map(r => ({
      id:            r.id,
      rootMessageId: r.root_message_id,
      agentId:       r.agent_id,
      createdAt:     r.created_at,
    }));
  }


  // ---- /delete ----

  private handleDeleteThread(threadId: string): Response {
    const rows = this.sql<{ id: string }>`SELECT id FROM threads WHERE id = ${threadId}`;
    if (rows.length === 0) {
      return Response.json({ ok: true, missing: true });
    }
    this.sql`DELETE FROM threads WHERE id = ${threadId}`;
    this.sql`UPDATE messages SET thread_id = NULL WHERE thread_id = ${threadId}`;
    this.broadcast(JSON.stringify({ type: "thread:deleted", threadId }));
    return Response.json({ ok: true, threadId });
  }

  private async handleDeleteRoom(): Promise<Response> {
    // Collect thread ids before we wipe so the worker can clean up the
    // per-thread Agent DOs.
    const threadIds = [...this.sql<{ id: string }>`SELECT id FROM threads`].map(r => r.id);
    this.broadcast(JSON.stringify({ type: "room:deleted" }));
    // Wipe storage. Schema is recreated lazily on next onStart() if the DO
    // is ever re-addressed, but in normal flow this id is gone for good.
    await this.ctx.storage.deleteAll();
    return Response.json({ ok: true, threadIds });
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


