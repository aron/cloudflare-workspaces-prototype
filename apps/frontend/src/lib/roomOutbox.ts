/**
 * Persistent client-side outbox for room messages.
 *
 * The room composer used to POST a message and pray: if the worker (or the
 * Room DO) restarted mid-request, the response was lost and the message
 * silently vanished. The outbox closes that gap by buffering every send to
 * `localStorage` keyed by room, paired with a stable `clientId` the Room
 * uses to dedupe retries.
 *
 * Lifecycle of one send:
 *   1. `enqueue()` writes `{ clientId, parts, createdAt }` to the outbox
 *      and the UI shows an optimistic message.
 *   2. The composer POSTs with the `clientId`.
 *   3. On success, `remove()` drops the entry.
 *   4. On network error or page reload, the entry stays. A flusher (called
 *      on mount and on WS reconnect) re-POSTs every queued entry. The
 *      Room DO's `messages_client_id` unique index turns duplicate POSTs
 *      into a no-op that returns the original row, so retries are safe.
 *
 * No expiry today — if the user never reconnects, the entry sits there
 * until they do. We can revisit if abandoned tabs become a problem.
 */
export interface OutboxEntry {
  clientId:  string;
  parts:     Array<{ type: "text"; text: string }>;
  createdAt: number;
}

const KEY_PREFIX = "roomOutbox:v1:";

function keyFor(roomId: string): string {
  return KEY_PREFIX + roomId;
}

function readAll(roomId: string): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(roomId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeAll(roomId: string, entries: OutboxEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(keyFor(roomId));
    } else {
      localStorage.setItem(keyFor(roomId), JSON.stringify(entries));
    }
  } catch {
    // localStorage may be full or disabled (private mode); the send still
    // happens, we just lose retry-across-reload semantics for this entry.
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<OutboxEntry>;
  return (
    typeof e.clientId === "string" &&
    typeof e.createdAt === "number" &&
    Array.isArray(e.parts)
  );
}

/** Push a new entry onto the outbox and return the full new list. */
export function enqueue(roomId: string, entry: OutboxEntry): OutboxEntry[] {
  const next = [...readAll(roomId), entry];
  writeAll(roomId, next);
  return next;
}

/** Remove the entry with the given clientId. No-op if it isn't present. */
export function remove(roomId: string, clientId: string): OutboxEntry[] {
  const next = readAll(roomId).filter(e => e.clientId !== clientId);
  writeAll(roomId, next);
  return next;
}

/** Snapshot the queued entries (oldest first). */
export function list(roomId: string): OutboxEntry[] {
  return readAll(roomId);
}

/** Fresh client id for a new send. */
export function newClientId(): string {
  return crypto.randomUUID();
}
