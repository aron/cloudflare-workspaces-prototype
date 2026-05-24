/**
 * URL ↔ Route model. The URL is the only source of truth for client-side
 * navigation state — we never put session/room ids in localStorage.
 *
 *   /                            → { kind: "picker" }
 *   /rooms/:roomId               → { kind: "room",   roomId }
 *   /rooms/:roomId/threads/:tid  → { kind: "thread", roomId, threadId }
 *
 * Unknown shapes fall back to the picker so a 404'd link still lands the
 * user somewhere usable.
 */

export type Route =
  | { kind: "picker" }
  | { kind: "room";   roomId: string }
  | { kind: "thread"; roomId: string; threadId: string };

export function parseRoute(pathname: string): Route {
  // Normalize: drop leading slash, drop trailing slash, then split.
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return { kind: "picker" };

  const parts = trimmed.split("/");
  if (parts[0] === "rooms" && parts[1] && parts.length === 2) {
    return { kind: "room", roomId: parts[1] };
  }
  if (
    parts[0] === "rooms" && parts[1] &&
    parts[2] === "threads" && parts[3] && parts.length === 4
  ) {
    return { kind: "thread", roomId: parts[1], threadId: parts[3] };
  }
  return { kind: "picker" };
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case "picker": return "/";
    case "room":   return `/rooms/${route.roomId}`;
    case "thread": return `/rooms/${route.roomId}/threads/${route.threadId}`;
  }
}
