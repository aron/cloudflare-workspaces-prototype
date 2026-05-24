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
import { currentModelLabel } from "./model.js";
import type { RoomSummary, UserSummary } from "@app/shared";

/** Stable singleton id used by the worker to address this DO. */
export const APP_DO_NAME = "app";

export type { RoomSummary, UserSummary } from "@app/shared";


export class App extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL,
        name       TEXT NOT NULL,
        last_seen  INTEGER NOT NULL
      )
    `);
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
    const identity = requireIdentity(request);
    if (identity instanceof Response) return identity;
    this.touchUser(identity);

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
        id:        crypto.randomUUID(),
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
