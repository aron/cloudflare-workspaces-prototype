/**
 * App — singleton Durable Object holding application-wide state.
 *
 * Today: a directory of users (anyone who has ever signed in) and a registry
 * of rooms. Per-room state lives in Room; per-thread state lives in Agent DO.
 *
 * Built on `partyserver` for the same reason as Room: WebSocket fanout for
 * presence + receipts is `this.broadcast(...)`, with hibernation so the DO
 * unloads while idle and live sockets pick up where they left off.
 *
 * Singleton key: `idFromName("app")`. There is exactly one of these.
 */

import { Server } from "partyserver";
import { readIdentity, requireIdentity } from "./identity.js";
import { shortId } from "./ids.js";
import { currentModelLabel } from "./model.js";
import { buildSnippet, log, pickRoomUrl, sendGChatMention } from "./notify.js";
import type { ActivityTip, ReadReceipt, ReceiptScope, RoomSummary, UserSummary, UserSettings } from "@app/shared";

/** Stable singleton id used by the worker to address this DO. */
export const APP_DO_NAME = "app";

export type { ActivityTip, ReadReceipt, ReceiptScope, RoomSummary, UserSummary, UserSettings } from "@app/shared";


export class App extends Server<Env> {
  // Enable hibernation so the singleton App DO can be evicted while idle
  // and WebSockets reconnect transparently — mirrors Room.
  static options = { hibernate: true };

  /**
   * Direct SqlStorage handle. Server's own `this.sql` is a tagged-template
   * helper; App's pre-receipts queries were written against the imperative
   * `.exec()` API, so we expose the raw storage under a different name to
   * avoid a sweeping rewrite.
   */
  private get db(): SqlStorage { return this.ctx.storage.sql; }

  /** Schema setup runs on every DO start (workerd may evict & re-create us). */
  override onStart(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                   TEXT PRIMARY KEY,
        email                TEXT NOT NULL,
        name                 TEXT NOT NULL,
        last_seen            INTEGER NOT NULL,
        google_chat_user_id  TEXT
      )
    `);
    // Idempotent migration for users created before google_chat_user_id existed.
    const userCols = [...this.db.exec<{ name: string }>(`PRAGMA table_info(users)`)];
    if (!userCols.some(c => c.name === "google_chat_user_id")) {
      this.db.exec(`ALTER TABLE users ADD COLUMN google_chat_user_id TEXT`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS rooms_created_at ON rooms(created_at DESC)`);
    // Idempotent migration: rooms gained last_activity_at when read receipts
    // landed. Mirrors the google_chat_user_id migration above.
    const roomCols = [...this.db.exec<{ name: string }>(`PRAGMA table_info(rooms)`)];
    if (!roomCols.some(c => c.name === "last_activity_at")) {
      this.db.exec(`ALTER TABLE rooms ADD COLUMN last_activity_at INTEGER`);
    }
    // Per-thread activity tip. We track threads here (rather than on the
    // Agent DO) so the sidebar can build unread badges with a single query.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_activity (
        thread_id        TEXT PRIMARY KEY,
        room_id          TEXT NOT NULL,
        last_activity_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS thread_activity_room ON thread_activity(room_id)`);
    // Per-user read markers. (user_id, scope, scope_id) is unique; lastRead
    // is monotonic — updates only ever move forward.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS read_receipts (
        user_id    TEXT NOT NULL,
        scope      TEXT NOT NULL,
        scope_id   TEXT NOT NULL,
        last_read  INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, scope, scope_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS read_receipts_user ON read_receipts(user_id, scope)`);
    // Pending mention notifications. Each @mention enqueues a row here
    // with `ready_at = createdAt + DEBOUNCE_MS`; a cron-driven drain pass
    // fires (or drops) them once the window elapses. Rows are retained
    // post-send/drop for audit and swept on the same cron tick.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        room_id         TEXT NOT NULL,
        thread_id       TEXT,
        message_id      TEXT NOT NULL,
        scope           TEXT NOT NULL,
        scope_id        TEXT NOT NULL,
        snippet         TEXT NOT NULL,
        author_name     TEXT NOT NULL,
        room_name       TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        ready_at        INTEGER NOT NULL,
        sent_at         INTEGER,
        dropped_at      INTEGER,
        dropped_reason  TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Drain queries scan by (sent_at, dropped_at, ready_at); housekeeping
    // scans by user/scope. One composite covers the hot path.
    this.db.exec(`CREATE INDEX IF NOT EXISTS pending_notifications_ready ON pending_notifications(sent_at, dropped_at, ready_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS pending_notifications_group ON pending_notifications(user_id, scope, scope_id)`);
  }

  override async onRequest(request: Request): Promise<Response> {
    const url      = new URL(request.url);

    // POST /activity { scope, scopeId, roomId?, lastActivity } — internal
    // DO-to-DO endpoint. Room/Agent DOs call this after appending a message
    // so the App tracks the activity tip in one place for sidebar badges.
    // Monotonic: only ever advances. Not exposed via any public worker route.
    if (request.method === "POST" && url.pathname.endsWith("/activity")) {
      return this.handleActivity(request);
    }

    // POST /notifications/enqueue — internal DO-to-DO endpoint. Room/Agent
    // call this once per @mention; we hold the row for DEBOUNCE_MS, then
    // the scheduled drain pass fires or drops based on the recipient's
    // current read receipt. Not exposed via any public worker route.
    if (request.method === "POST" && url.pathname.endsWith("/notifications/enqueue")) {
      return this.handleEnqueueNotifications(request);
    }

    // POST /notifications/drain — cron-triggered. Called by the worker's
    // `scheduled()` handler every minute. Idempotent: a partial drain is
    // safe to retry because each row's state machine (pending → sent /
    // dropped) is monotonic.
    if (request.method === "POST" && url.pathname.endsWith("/notifications/drain")) {
      return Response.json(await this.drainPendingNotifications(Date.now()));
    }

    // POST /__test/presence-ttl { ms } — test seam. Shrinks the presence TTL
    // so eviction can be exercised without sleeping a minute. Worker blocks
    // any `/api/app/__test/*` path so this is unreachable in production.
    if (request.method === "POST" && url.pathname.endsWith("/__test/presence-ttl")) {
      const body = await request.json().catch(() => ({})) as { ms?: unknown };
      if (typeof body.ms === "number" && body.ms >= 0) {
        (App as unknown as { PRESENCE_TTL_MS: number }).PRESENCE_TTL_MS = body.ms;
      }
      return Response.json({ ok: true });
    }

    // POST /__test/notif-debounce { ms } — test seam. Same gating as the
    // presence-ttl knob: any /api/app/__test/* path is blocked at the worker.
    if (request.method === "POST" && url.pathname.endsWith("/__test/notif-debounce")) {
      const body = await request.json().catch(() => ({})) as { ms?: unknown };
      if (typeof body.ms === "number" && body.ms >= 0) {
        (App as unknown as { NOTIF_DEBOUNCE_MS: number }).NOTIF_DEBOUNCE_MS = body.ms;
      }
      return Response.json({ ok: true });
    }

    // POST /__test/clear-notifications — wipe the queue. Lets tests sharing
    // the singleton App DO start each case from a clean slate.
    if (request.method === "POST" && url.pathname.endsWith("/__test/clear-notifications")) {
      this.db.exec(`DELETE FROM pending_notifications`);
      return Response.json({ ok: true });
    }

    const identity = requireIdentity(request);
    if (identity instanceof Response) return identity;
    this.touchUser(identity);

    // GET /me/settings — owner-only read of per-user settings.
    if (request.method === "GET" && url.pathname.endsWith("/me/settings")) {
      return Response.json(this.loadSettings(identity.userId));
    }

    // PUT /me/settings { googleChatUserId } — owner-only write.
    if (request.method === "PUT" && url.pathname.endsWith("/me/settings")) {
      const body = await request.json().catch(() => ({})) as { googleChatUserId?: unknown };
      const raw = body.googleChatUserId;
      let gid: string | null;
      if (raw === null || raw === undefined || raw === "") {
        gid = null;
      } else if (typeof raw === "string" && /^[0-9]{5,30}$/.test(raw.trim())) {
        gid = raw.trim();
      } else {
        return Response.json({ error: "googleChatUserId must be 5–30 digits or null" }, { status: 400 });
      }
      this.db.exec(`UPDATE users SET google_chat_user_id = ? WHERE id = ?`, gid, identity.userId);
      return Response.json(this.loadSettings(identity.userId));
    }

    // GET /me/receipts — owner-only. Returns this user's read markers plus
    // every activity tip we know about, so the client can compute unread
    // badges in one round-trip on boot.
    if (request.method === "GET" && url.pathname.endsWith("/me/receipts")) {
      return Response.json({
        receipts: this.listReceipts(identity.userId),
        tips:     this.listTips(),
      });
    }

    // PUT /me/receipts { scope, scopeId, lastRead } — owner-only. Monotonic:
    // the stored value never moves backwards even if the client sends stale
    // timestamps after a reconnect.
    if (request.method === "PUT" && url.pathname.endsWith("/me/receipts")) {
      return this.handlePutReceipt(request, identity.userId);
    }

    // GET /me — identity echo + user upsert side-effect (already done above).
    if (request.method === "GET" && url.pathname.endsWith("/me")) {
      return Response.json({
        userId: identity.userId,
        email:  identity.email,
        name:   identity.name,
        model:  currentModelLabel(this.env),
      });
    }

    // GET /users — directory of every user that has signed in.
    if (request.method === "GET" && url.pathname.endsWith("/users")) {
      return Response.json({ users: this.listUsers() });
    }

    // GET /rooms — list all rooms, newest first.
    if (request.method === "GET" && url.pathname.endsWith("/rooms")) {
      return Response.json({ rooms: this.listRooms() });
    }

    // POST /rooms { name } — any authenticated user can create.
    if (request.method === "POST" && url.pathname.endsWith("/rooms")) {
      const body = await request.json().catch(() => ({})) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return Response.json({ error: "name is required" }, { status: 400 });
      }
      if (name.length > 80) {
        return Response.json({ error: "name too long (max 80 chars)" }, { status: 400 });
      }
      const room: RoomSummary = {
        id:        shortId(),
        name,
        createdBy: identity.userId,
        createdAt: Date.now(),
      };
      this.db.exec(
        `INSERT INTO rooms(id, name, created_by, created_at) VALUES (?, ?, ?, ?)`,
        room.id, room.name, room.createdBy, room.createdAt,
      );
      return Response.json({ room }, { status: 201 });
    }

    // DELETE /rooms/:id — remove the registry row. Per-room state lives in
    // the Room DO and is wiped separately by the worker.
    {
      const m = url.pathname.match(/\/rooms\/([^/]+)\/?$/);
      if (request.method === "DELETE" && m) {
        const id = m[1];
        this.db.exec(`DELETE FROM rooms WHERE id = ?`, id);
        return Response.json({ ok: true });
      }
    }


    return new Response("not found", { status: 404 });
  }

  // ---- helpers ----

  private touchUser(identity: { userId: string; email: string; name: string }) {
    this.db.exec(
      `INSERT INTO users(id, email, name, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email,
                                     name  = excluded.name,
                                     last_seen = excluded.last_seen`,
      identity.userId, identity.email, identity.name, Date.now(),
    );
  }

  private loadSettings(userId: string): UserSettings {
    const rows = [...this.db.exec<{ google_chat_user_id: string | null }>(
      `SELECT google_chat_user_id FROM users WHERE id = ?`, userId,
    )];
    return { googleChatUserId: rows[0]?.google_chat_user_id ?? null };
  }

  private listRooms(): RoomSummary[] {
    const rows = this.db.exec<{
      id: string; name: string; created_by: string; created_at: number;
    }>(`SELECT id, name, created_by, created_at FROM rooms ORDER BY created_at DESC LIMIT 200`);
    return [...rows].map(r => ({
      id:        r.id,
      name:      r.name,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  private listUsers(): UserSummary[] {
    const rows = this.db.exec<{
      id: string; email: string; name: string; last_seen: number;
    }>(`SELECT id, email, name, last_seen FROM users ORDER BY last_seen DESC LIMIT 500`);
    return [...rows].map(r => ({
      id:       r.id,
      email:    r.email,
      name:     r.name,
      username: deriveUsername(r.email),
      lastSeen: r.last_seen,
    }));
  }

  // ---- receipts / activity ----

  /**
   * Bump the activity tip for a scope. Monotonic: stored value only ever
   * advances. Room tips also bump the denormalised `rooms.last_activity_at`
   * column so the sidebar can sort/badge from a single query.
   */
  private async handleActivity(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as {
      scope?: unknown; scopeId?: unknown; roomId?: unknown; lastActivity?: unknown;
    };
    const scope = body.scope === "room" || body.scope === "thread" ? body.scope : null;
    const scopeId = typeof body.scopeId === "string" && body.scopeId.length > 0 && body.scopeId.length <= 128
      ? body.scopeId
      : null;
    const lastActivity = typeof body.lastActivity === "number" && Number.isFinite(body.lastActivity)
      ? body.lastActivity
      : null;
    if (!scope || !scopeId || lastActivity === null) {
      return Response.json({ error: "scope, scopeId, lastActivity required" }, { status: 400 });
    }
    if (scope === "room") {
      // COALESCE keeps the old value when it's already ahead of the incoming
      // timestamp — a late retry can't clobber a newer write.
      this.db.exec(
        `UPDATE rooms
            SET last_activity_at = CASE
              WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
              ELSE last_activity_at END
          WHERE id = ?`,
        lastActivity, lastActivity, scopeId,
      );
    } else {
      const roomId = typeof body.roomId === "string" && body.roomId.length > 0 ? body.roomId : null;
      if (!roomId) {
        return Response.json({ error: "roomId required for thread scope" }, { status: 400 });
      }
      this.db.exec(
        `INSERT INTO thread_activity(thread_id, room_id, last_activity_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           last_activity_at = CASE
             WHEN thread_activity.last_activity_at < excluded.last_activity_at
               THEN excluded.last_activity_at
             ELSE thread_activity.last_activity_at END`,
        scopeId, roomId, lastActivity,
      );
    }
    // Broadcast the new tip to every connected client so sidebars light up
    // unread badges without polling. Best-effort — the SQL write is the
    // source of truth; sockets just get a head start.
    const roomIdOut = scope === "thread"
      ? (typeof body.roomId === "string" ? body.roomId : undefined)
      : undefined;
    const tipFrame = JSON.stringify({
      type: "tip",
      scope, scopeId, lastActivity,
      ...(roomIdOut ? { roomId: roomIdOut } : {}),
    });
    this.broadcast(tipFrame);
    // Auto-advance receipts for users currently focused on this scope:
    // saves the client a follow-up PUT when the tab is already open.
    this.autoAdvanceFocusedReceipts(scope, scopeId, lastActivity);
    return Response.json({ ok: true });
  }

  /**
   * Owner-only write of a read marker. Monotonic: a stale `lastRead` can't
   * roll the stored value backwards (so a slow tab catching up after a
   * reconnect won't undo progress made in a faster one).
   */
  private async handlePutReceipt(request: Request, userId: string): Promise<Response> {
    const body = await request.json().catch(() => ({})) as {
      scope?: unknown; scopeId?: unknown; lastRead?: unknown;
    };
    const scope = body.scope === "room" || body.scope === "thread" ? body.scope : null;
    const scopeId = typeof body.scopeId === "string" && body.scopeId.length > 0 && body.scopeId.length <= 128
      ? body.scopeId
      : null;
    const lastRead = typeof body.lastRead === "number" && Number.isFinite(body.lastRead)
      ? body.lastRead
      : null;
    if (!scope || !scopeId || lastRead === null) {
      return Response.json({ error: "scope, scopeId, lastRead required" }, { status: 400 });
    }
    const now = Date.now();
    this.db.exec(
      `INSERT INTO read_receipts(user_id, scope, scope_id, last_read, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, scope, scope_id) DO UPDATE SET
         last_read  = CASE
           WHEN read_receipts.last_read < excluded.last_read
             THEN excluded.last_read
           ELSE read_receipts.last_read END,
         updated_at = CASE
           WHEN read_receipts.last_read < excluded.last_read
             THEN excluded.updated_at
           ELSE read_receipts.updated_at END`,
      userId, scope, scopeId, lastRead, now,
    );
    const stored = [...this.db.exec<{ last_read: number }>(
      `SELECT last_read FROM read_receipts WHERE user_id = ? AND scope = ? AND scope_id = ?`,
      userId, scope, scopeId,
    )][0];
    const finalLastRead = stored?.last_read ?? lastRead;
    // Echo the receipt to every other tab this user has open so they stay
    // in sync. We tag the frame with userId; the client filters on it.
    this.broadcast(JSON.stringify({
      type: "receipt",
      userId, scope, scopeId, lastRead: finalLastRead,
    }));
    return Response.json({
      receipt: { scope, scopeId, lastRead: finalLastRead } satisfies ReadReceipt,
    });
  }

  private listReceipts(userId: string): ReadReceipt[] {
    const rows = this.db.exec<{ scope: string; scope_id: string; last_read: number }>(
      `SELECT scope, scope_id, last_read FROM read_receipts WHERE user_id = ?`,
      userId,
    );
    return [...rows].map(r => ({
      scope:    r.scope as ReceiptScope,
      scopeId:  r.scope_id,
      lastRead: r.last_read,
    }));
  }

  private listTips(): ActivityTip[] {
    const rooms = this.db.exec<{ id: string; last_activity_at: number | null }>(
      `SELECT id, last_activity_at FROM rooms WHERE last_activity_at IS NOT NULL`,
    );
    const threads = this.db.exec<{ thread_id: string; room_id: string; last_activity_at: number }>(
      `SELECT thread_id, room_id, last_activity_at FROM thread_activity`,
    );
    const out: ActivityTip[] = [];
    for (const r of rooms) {
      out.push({ scope: "room", scopeId: r.id, lastActivity: r.last_activity_at as number });
    }
    for (const t of threads) {
      out.push({ scope: "thread", scopeId: t.thread_id, roomId: t.room_id, lastActivity: t.last_activity_at });
    }
    return out;
  }

  // ---- notifications ----

  /**
   * How long a mention sits in the queue before becoming eligible for
   * delivery. Tunable per test via the `__test/notif-debounce` route.
   */
  private static NOTIF_DEBOUNCE_MS = 60_000;

  /** How long sent/dropped rows are retained for audit before sweeping. */
  private static NOTIF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  /** Max delivery attempts before giving up on a row. */
  private static NOTIF_MAX_ATTEMPTS = 5;

  /**
   * Insert one row per mention with `ready_at = createdAt + DEBOUNCE_MS`.
   * Idempotent on `(message_id, user_id)`: re-enqueueing the same mention
   * (e.g. after a Room DO retry) is a no-op. We don't dedupe across the
   * sent/dropped audit history — only against rows still in flight.
   */
  private async handleEnqueueNotifications(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { mentions?: unknown };
    if (!Array.isArray(body.mentions) || body.mentions.length === 0) {
      return Response.json({ enqueued: 0 });
    }
    let enqueued = 0;
    for (const m of body.mentions) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      const userId    = typeof mm.userId    === "string" ? mm.userId    : null;
      const roomId    = typeof mm.roomId    === "string" ? mm.roomId    : null;
      const messageId = typeof mm.messageId === "string" ? mm.messageId : null;
      const snippet   = typeof mm.snippet   === "string" ? mm.snippet   : "";
      const author    = typeof mm.authorName === "string" ? mm.authorName : "someone";
      const roomName  = typeof mm.roomName  === "string" ? mm.roomName  : "";
      const createdAt = typeof mm.createdAt === "number" && Number.isFinite(mm.createdAt) ? mm.createdAt : null;
      const threadId  = typeof mm.threadId  === "string" ? mm.threadId  : null;
      if (!userId || !roomId || !messageId || createdAt === null) continue;

      const scope: ReceiptScope = threadId ? "thread" : "room";
      const scopeId = threadId ?? roomId;
      const readyAt = createdAt + App.NOTIF_DEBOUNCE_MS;

      // Idempotency: skip if an in-flight row already exists for this
      // (message_id, user_id). We allow re-enqueuing past a sweep —
      // unlikely but harmless given the receipt check at drain time.
      const dup = [...this.db.exec<{ id: string }>(
        `SELECT id FROM pending_notifications
          WHERE message_id = ? AND user_id = ? AND sent_at IS NULL AND dropped_at IS NULL
          LIMIT 1`,
        messageId, userId,
      )];
      if (dup.length > 0) continue;

      this.db.exec(
        `INSERT INTO pending_notifications(
           id, user_id, room_id, thread_id, message_id, scope, scope_id,
           snippet, author_name, room_name, created_at, ready_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        shortId(), userId, roomId, threadId, messageId, scope, scopeId,
        snippet, author, roomName, createdAt, readyAt,
      );
      enqueued += 1;
    }
    return Response.json({ enqueued });
  }

  /**
   * Drain pass. Walks every ready row, groups by recipient + scope, and:
   *   — drops the group when the recipient's `lastRead` has already moved
   *     past the latest mention (`dropped_reason = "read"`).
   *   — otherwise fires one summary Google Chat ping and marks every row
   *     in the group `sent_at = now`.
   * Rows whose webhook delivery fails get `attempts += 1` and stay pending
   * for the next tick, up to NOTIF_MAX_ATTEMPTS.
   *
   * Also sweeps audit rows older than NOTIF_RETENTION_MS.
   * Returns counters for observability + tests.
   */
  async drainPendingNotifications(now: number): Promise<{
    sent: number; dropped: number; failed: number; swept: number;
  }> {
    const webhookUrl = (this.env as { GCHAT_WEBHOOK_URL?: string }).GCHAT_WEBHOOK_URL ?? null;
    const baseUrl    = (this.env as { APP_BASE_URL?: string }).APP_BASE_URL ?? null;

    const rows = [...this.db.exec<{
      id: string; user_id: string; room_id: string; thread_id: string | null;
      message_id: string; scope: string; scope_id: string; snippet: string;
      author_name: string; room_name: string; created_at: number;
    }>(
      `SELECT id, user_id, room_id, thread_id, message_id, scope, scope_id,
              snippet, author_name, room_name, created_at
         FROM pending_notifications
        WHERE sent_at IS NULL AND dropped_at IS NULL AND ready_at <= ?
          AND attempts < ?
        ORDER BY created_at ASC`,
      now, App.NOTIF_MAX_ATTEMPTS,
    )];

    // Group by (user_id, scope, scope_id) so a flurry of mentions to one
    // person in one room/thread collapses into a single webhook call.
    type Group = {
      userId: string; scope: ReceiptScope; scopeId: string;
      roomId: string; threadId: string | null; roomName: string;
      rows: typeof rows;
      latestSnippet: string; latestCreatedAt: number;
      authors: Set<string>;
    };
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const key = `${r.user_id}|${r.scope}|${r.scope_id}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          userId: r.user_id, scope: r.scope as ReceiptScope, scopeId: r.scope_id,
          roomId: r.room_id, threadId: r.thread_id, roomName: r.room_name,
          rows: [], latestSnippet: "", latestCreatedAt: 0, authors: new Set(),
        };
        groups.set(key, g);
      }
      g.rows.push(r);
      if (r.created_at > g.latestCreatedAt) {
        g.latestCreatedAt = r.created_at;
        g.latestSnippet   = r.snippet;
      }
      g.authors.add(r.author_name);
    }

    let sent = 0, dropped = 0, failed = 0;
    for (const g of groups.values()) {
      // Receipt check: if the user has read past the latest mention in this
      // scope, drop the whole group. Mid-flight reads are caught here.
      const lastRead = [...this.db.exec<{ last_read: number }>(
        `SELECT last_read FROM read_receipts WHERE user_id = ? AND scope = ? AND scope_id = ?`,
        g.userId, g.scope, g.scopeId,
      )][0]?.last_read ?? 0;
      if (lastRead >= g.latestCreatedAt) {
        const ids = g.rows.map(r => r.id);
        this.markDropped(ids, now, "read");
        dropped += ids.length;
        continue;
      }

      // Look up Google Chat ID for the recipient. No webhook configured
      // (or no ID on file) → drop with reason "unconfigured" so we don't
      // hammer the queue forever on rows we can never deliver.
      const user = [...this.db.exec<{ google_chat_user_id: string | null }>(
        `SELECT google_chat_user_id FROM users WHERE id = ?`, g.userId,
      )][0];
      const gid = user?.google_chat_user_id ?? null;
      if (!webhookUrl || !gid) {
        const ids = g.rows.map(r => r.id);
        this.markDropped(ids, now, !webhookUrl ? "no-webhook" : "no-gchat-id");
        dropped += ids.length;
        continue;
      }

      // Build the summary. One ping covers every queued mention; we
      // include a count when there's more than one so the recipient knows
      // they missed a burst.
      const count = g.rows.length;
      const snippet = count > 1
        ? `${count} new mentions — latest: ${g.latestSnippet}`
        : g.latestSnippet;
      const roomUrl = pickRoomUrl({
        baseUrl:   baseUrl ?? undefined,
        roomId:    g.roomId,
        threadId:  g.threadId ?? undefined,
        messageId: g.rows[g.rows.length - 1]?.message_id,
      });

      const ok = await sendGChatMention({
        webhookUrl,
        googleChatUserId: gid,
        roomName: g.roomName || "room",
        snippet:  buildSnippet(snippet),
        roomUrl,
      });
      if (ok) {
        const ids = g.rows.map(r => r.id);
        this.markSent(ids, now);
        sent += ids.length;
      } else {
        // Bump attempts so a permanently-broken webhook gives up after
        // NOTIF_MAX_ATTEMPTS rather than retrying forever.
        for (const r of g.rows) {
          this.db.exec(
            `UPDATE pending_notifications SET attempts = attempts + 1 WHERE id = ?`,
            r.id,
          );
        }
        failed += g.rows.length;
        log("warn", "notif drain delivery failed", { recipient: g.userId, room: g.roomId });
      }
    }

    // Sweep audit rows past retention.
    const sweepCutoff = now - App.NOTIF_RETENTION_MS;
    const sweptRows = this.db.exec(
      `DELETE FROM pending_notifications
        WHERE (sent_at IS NOT NULL AND sent_at < ?)
           OR (dropped_at IS NOT NULL AND dropped_at < ?)`,
      sweepCutoff, sweepCutoff,
    );
    const swept = sweptRows.rowsWritten;

    return { sent, dropped, failed, swept };
  }

  private markSent(ids: string[], now: number): void {
    for (const id of ids) {
      this.db.exec(`UPDATE pending_notifications SET sent_at = ? WHERE id = ?`, now, id);
    }
  }
  private markDropped(ids: string[], now: number, reason: string): void {
    for (const id of ids) {
      this.db.exec(
        `UPDATE pending_notifications SET dropped_at = ?, dropped_reason = ? WHERE id = ?`,
        now, reason, id,
      );
    }
  }

  // ---- presence + WebSocket ----

  /**
   * In-memory presence map: userId → where they're currently focused. Used
   * to auto-advance receipts when a message lands on a scope a user is
   * actively viewing (belt-and-suspenders for the client-side trigger).
   *
   * Lives only in memory — a hibernation wake clears it, and clients
   * re-send `focus` on reconnect.
   */
  private presence = new Map<string, { scope: ReceiptScope; scopeId: string; lastPingAt: number }>();

  /** TTL after which a presence entry is treated as stale (no heartbeat). */
  /**
   * TTL after which a presence entry is treated as stale (no heartbeat).
   * Mutable (not `readonly`) so tests can shrink the window without faking
   * timers — the workers test pool doesn't expose `vi.useFakeTimers()`
   * in a way that reaches inside a Server.
   */
  private static PRESENCE_TTL_MS = 60_000;

  /**
   * Authenticate the WS upgrade and stash the user's identity on the
   * connection so subsequent frames know who's talking. The worker has
   * already required identity for `/api/app/*`, but we re-read defensively
   * in case the DO is ever addressed directly in tests.
   */
  override async onConnect(connection: import("partyserver").Connection, ctx: import("partyserver").ConnectionContext): Promise<void> {
    const id = readIdentity(ctx.request as Request);
    if (!id) {
      connection.close(4401, "unauthenticated");
      return;
    }
    connection.setState({ userId: id.userId });
  }

  /**
   * Presence protocol:
   *   { type: "focus", scope, scopeId }  — user is viewing this scope
   *   { type: "blur" }                   — user navigated away / tab hidden
   *   { type: "ping" }                   — heartbeat, server replies "pong"
   * Anything else is ignored.
   */
  override async onMessage(connection: import("partyserver").Connection, message: import("partyserver").WSMessage): Promise<void> {
    if (typeof message !== "string") return;
    const userId = (connection.state as { userId?: string } | null)?.userId;
    if (!userId) return;
    let frame: unknown;
    try { frame = JSON.parse(message); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    const f = frame as { type?: unknown; scope?: unknown; scopeId?: unknown };
    if (f.type === "ping") {
      connection.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (f.type === "focus") {
      const scope = f.scope === "room" || f.scope === "thread" ? f.scope : null;
      const scopeId = typeof f.scopeId === "string" && f.scopeId.length > 0 ? f.scopeId : null;
      if (!scope || !scopeId) return;
      this.presence.set(userId, { scope, scopeId, lastPingAt: Date.now() });
      return;
    }
    if (f.type === "blur") {
      this.presence.delete(userId);
      return;
    }
  }

  override async onClose(connection: import("partyserver").Connection): Promise<void> {
    const userId = (connection.state as { userId?: string } | null)?.userId;
    if (userId) this.presence.delete(userId);
  }

  /**
   * Walk the presence map, find users focused on `(scope, scopeId)`, and
   * advance their receipt to `lastActivity` (monotonic via the same SQL
   * path as PUT /me/receipts). Broadcasts a `receipt` frame per user so
   * their other tabs see the update.
   */
  private autoAdvanceFocusedReceipts(scope: ReceiptScope, scopeId: string, lastActivity: number): void {
    const cutoff = Date.now() - App.PRESENCE_TTL_MS;
    const targets: string[] = [];
    for (const [userId, p] of this.presence) {
      if (p.lastPingAt < cutoff) { this.presence.delete(userId); continue; }
      if (p.scope === scope && p.scopeId === scopeId) targets.push(userId);
    }
    if (targets.length === 0) return;
    const now = Date.now();
    for (const userId of targets) {
      this.db.exec(
        `INSERT INTO read_receipts(user_id, scope, scope_id, last_read, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope, scope_id) DO UPDATE SET
           last_read  = CASE WHEN read_receipts.last_read < excluded.last_read
                              THEN excluded.last_read ELSE read_receipts.last_read END,
           updated_at = CASE WHEN read_receipts.last_read < excluded.last_read
                              THEN excluded.updated_at ELSE read_receipts.updated_at END`,
        userId, scope, scopeId, lastActivity, now,
      );
      this.broadcast(JSON.stringify({
        type: "receipt",
        userId, scope, scopeId, lastRead: lastActivity,
      }));
    }
  }
}

/**
 * Derive a stable mention handle from an email. The bit before `@`,
 * lowercased, with anything outside `[a-z0-9._-]` stripped. Falls back to
 * `"user"` for pathological inputs so we never produce an empty handle.
 */
export function deriveUsername(email: string): string {
  const local = email.split("@")[0] ?? "";
  const clean = local.toLowerCase().replace(/[^a-z0-9._-]+/g, "");
  return clean || "user";
}
