/**
 * App — singleton Durable Object holding application-wide state.
 *
 * Today: a directory of users (anyone who has ever signed in) and a registry
 * of rooms. Per-room state lives in Room; per-thread state lives in Agent DO.
 *
 * Singleton key: `idFromName("app")`. There is exactly one of these.
 */

import { DurableObject } from "cloudflare:workers";
import { requireIdentity } from "./identity.js";
import { shortId } from "./ids.js";
import { currentModelLabel } from "./model.js";
import type { RoomSummary, UserSummary, UserSettings } from "@app/shared";

/** Stable singleton id used by the worker to address this DO. */
export const APP_DO_NAME = "app";

export type { RoomSummary, UserSummary, UserSettings } from "@app/shared";


export class App extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                   TEXT PRIMARY KEY,
        email                TEXT NOT NULL,
        name                 TEXT NOT NULL,
        last_seen            INTEGER NOT NULL,
        google_chat_user_id  TEXT
      )
    `);
    // Idempotent migration for users created before google_chat_user_id existed.
    const userCols = [...this.sql.exec<{ name: string }>(`PRAGMA table_info(users)`)];
    if (!userCols.some(c => c.name === "google_chat_user_id")) {
      this.sql.exec(`ALTER TABLE users ADD COLUMN google_chat_user_id TEXT`);
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS rooms_created_at ON rooms(created_at DESC)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url      = new URL(request.url);
    // POST /notify-lookup { userIds: string[] } — internal DO-to-DO endpoint
    // used by Room DO to look up Google Chat IDs for mention notifications.
    // No identity required (DO stubs hop the worker middleware). We never
    // expose this through any public worker route, and per-user Google IDs
    // never leak through /users.
    if (request.method === "POST" && url.pathname.endsWith("/notify-lookup")) {
      const body = await request.json().catch(() => ({})) as { userIds?: unknown };
      const ids = Array.isArray(body.userIds)
        ? body.userIds.filter((x): x is string => typeof x === "string").slice(0, 100)
        : [];
      if (ids.length === 0) return Response.json({ users: [] });
      const placeholders = ids.map(() => "?").join(",");
      const rows = [...this.sql.exec<{
        id: string; name: string; email: string; google_chat_user_id: string | null;
      }>(
        `SELECT id, name, email, google_chat_user_id FROM users WHERE id IN (${placeholders})`,
        ...ids,
      )];
      return Response.json({
        users: rows.map(r => ({
          userId:           r.id,
          name:             r.name,
          email:            r.email,
          googleChatUserId: r.google_chat_user_id,
        })),
      });
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
      this.sql.exec(`UPDATE users SET google_chat_user_id = ? WHERE id = ?`, gid, identity.userId);
      return Response.json(this.loadSettings(identity.userId));
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
      this.sql.exec(
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
        this.sql.exec(`DELETE FROM rooms WHERE id = ?`, id);
        return Response.json({ ok: true });
      }
    }


    return new Response("not found", { status: 404 });
  }

  // ---- helpers ----

  private touchUser(identity: { userId: string; email: string; name: string }) {
    this.sql.exec(
      `INSERT INTO users(id, email, name, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email,
                                     name  = excluded.name,
                                     last_seen = excluded.last_seen`,
      identity.userId, identity.email, identity.name, Date.now(),
    );
  }

  private loadSettings(userId: string): UserSettings {
    const rows = [...this.sql.exec<{ google_chat_user_id: string | null }>(
      `SELECT google_chat_user_id FROM users WHERE id = ?`, userId,
    )];
    return { googleChatUserId: rows[0]?.google_chat_user_id ?? null };
  }

  private listRooms(): RoomSummary[] {
    const rows = this.sql.exec<{
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
    const rows = this.sql.exec<{
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
