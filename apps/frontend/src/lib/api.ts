/**
 * Typed wrappers around the worker's HTTP API. One function per route so
 * callers don't have to remember URL shapes or response envelopes.
 *
 * All requests include credentials so the Cloudflare Access CF_Authorization
 * cookie is sent on cross-handler navigations.
 */

import type { ActivityTip, AppMessage, Me, ReadReceipt, ReceiptScope, RoomMeta, RoomSummary, ThreadRow, UserSettings, UserSummary } from "@app/shared";
export type { ActivityTip, AppMessage, Me, ReadReceipt, ReceiptScope, RoomMeta, RoomSummary, ThreadRow, UserSettings, UserSummary };



const OPTS: RequestInit = { credentials: "same-origin" };



async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

// ---- /api/app ----

export async function fetchMe(): Promise<Me> {
  return jsonOrThrow(await fetch("/api/app/me", OPTS), "GET /api/app/me");
}

export async function fetchUsers(): Promise<UserSummary[]> {
  const body = await jsonOrThrow<{ users: UserSummary[] }>(
    await fetch("/api/app/users", OPTS),
    "GET /api/app/users",
  );
  return body.users;
}

export async function fetchMySettings(): Promise<UserSettings> {
  return jsonOrThrow(await fetch("/api/app/me/settings", OPTS), "GET /api/app/me/settings");
}

export async function updateMySettings(googleChatUserId: string | null): Promise<UserSettings> {
  return jsonOrThrow(
    await fetch("/api/app/me/settings", {
      ...OPTS,
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId }),
    }),
    "PUT /api/app/me/settings",
  );
}


export async function listRooms(): Promise<RoomSummary[]> {
  const body = await jsonOrThrow<{ rooms: RoomSummary[] }>(
    await fetch("/api/app/rooms", OPTS),
    "GET /api/app/rooms",
  );
  return body.rooms;
}

export async function createRoom(name: string): Promise<RoomSummary> {
  const body = await jsonOrThrow<{ room: RoomSummary }>(
    await fetch("/api/app/rooms", {
      ...OPTS,
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ name }),
    }),
    "POST /api/app/rooms",
  );
  return body.room;
}

export async function deleteRoom(roomId: string): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}`, { ...OPTS, method: "DELETE" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DELETE /api/rooms/${roomId} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export async function deleteThread(roomId: string, threadId: string): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/threads/${threadId}`, { ...OPTS, method: "DELETE" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DELETE /api/rooms/${roomId}/threads/${threadId} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

// ---- /api/rooms/:id ----

export async function fetchRoomMeta(roomId: string): Promise<RoomMeta> {
  return jsonOrThrow(
    await fetch(`/api/rooms/${roomId}/meta`, OPTS),
    `GET /api/rooms/${roomId}/meta`,
  );
}

export async function fetchRoomMessages(roomId: string): Promise<AppMessage[]> {
  const body = await jsonOrThrow<{ messages: AppMessage[] }>(
    await fetch(`/api/rooms/${roomId}/messages`, OPTS),
    `GET /api/rooms/${roomId}/messages`,
  );
  return body.messages;
}

export interface PostMessageResponse {
  message:   AppMessage;
  threadId?: string;
  /** Echoed back so the client outbox can match the response to its entry. */
  clientId?: string;
  /** True when the server returned a previously-persisted message for this clientId. */
  deduped?:  boolean;
}
export async function postRoomMessage(
  roomId: string,
  parts:  Array<{ type: "text"; text: string }>,
  /**
   * Stable client-side id for this attempted send. The Room DO uses it to
   * collapse retries onto a single persisted message, so a network blip
   * or DO redeploy mid-POST can't produce duplicates when the client
   * outbox replays.
   */
  clientId?: string,
): Promise<PostMessageResponse> {
  return jsonOrThrow(
    await fetch(`/api/rooms/${roomId}/messages`, {
      ...OPTS,
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts, clientId }),
    }),
    `POST /api/rooms/${roomId}/messages`,
  );
}

export async function fetchRoomThreads(roomId: string): Promise<ThreadRow[]> {
  const body = await jsonOrThrow<{ threads: ThreadRow[] }>(
    await fetch(`/api/rooms/${roomId}/threads`, OPTS),
    `GET /api/rooms/${roomId}/threads`,
  );
  return body.threads;
}

/** Open a WebSocket to the room for live message fanout. */
export function openRoomSocket(roomId: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/rooms/${roomId}/ws`);
}

// ---- /api/threads/:id ----

/**
 * Fetch a one‑or‑two sentence Kimi‑generated recap of a thread. The Agent
 * DO caches by message count, so calling this repeatedly is cheap.
 * Returns an empty string when the thread has nothing summarisable yet.
 */
export async function fetchThreadSummary(threadId: string): Promise<string> {
  const body = await jsonOrThrow<{ summary: string }>(
    await fetch(`/api/threads/${threadId}/summary`, OPTS),
    `GET /api/threads/${threadId}/summary`,
  );
  return body.summary;
}

// ---- read receipts / activity tips ----

/**
 * Snapshot of every receipt + tip the App DO knows about. The server
 * returns receipts scoped to the calling user; tips are global so the
 * sidebar can render unread badges for any room/thread.
 */
export interface ReceiptsSnapshot {
  receipts: ReadReceipt[];
  tips:     ActivityTip[];
}

export async function fetchReceipts(): Promise<ReceiptsSnapshot> {
  return jsonOrThrow(
    await fetch("/api/app/me/receipts", OPTS),
    "GET /api/app/me/receipts",
  );
}

/**
 * Server is monotonic: a stale `lastRead` never moves the stored value
 * backwards. We still send the latest known timestamp on every call so a
 * recovering tab catches up without special-casing.
 */
export async function putReceipt(scope: ReceiptScope, scopeId: string, lastRead: number): Promise<ReadReceipt> {
  const body = await jsonOrThrow<{ receipt: ReadReceipt }>(
    await fetch("/api/app/me/receipts", {
      ...OPTS,
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope, scopeId, lastRead }),
    }),
    "PUT /api/app/me/receipts",
  );
  return body.receipt;
}

/** Open the App-singleton WebSocket for presence + receipt/tip fanout. */
export function openAppSocket(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/app/ws`);
}
