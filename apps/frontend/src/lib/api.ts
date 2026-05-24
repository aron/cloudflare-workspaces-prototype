/**
 * Typed wrappers around the worker's HTTP API. One function per route so
 * callers don't have to remember URL shapes or response envelopes.
 *
 * All requests include credentials so the Cloudflare Access CF_Authorization
 * cookie is sent on cross-handler navigations.
 */

import type { AppMessage, Me, RoomMeta, RoomSummary, ThreadRow } from "@app/shared";
export type { AppMessage, Me, RoomMeta, RoomSummary, ThreadRow };

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

export interface PostMessageResponse { message: AppMessage; threadId?: string }
export async function postRoomMessage(
  roomId: string,
  parts:  Array<{ type: "text"; text: string }>,
): Promise<PostMessageResponse> {
  return jsonOrThrow(
    await fetch(`/api/rooms/${roomId}/messages`, {
      ...OPTS,
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts }),
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
