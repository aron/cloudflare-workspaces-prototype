/**
 * Pure helper for stamping `metadata.author` onto incoming user messages.
 *
 * Lives outside the Agent DO so it's trivially unit-testable. The Agent DO's
 * `onMessage` calls this on every `cf_agent_use_chat_request` payload before
 * delegating to the AIChatAgent base class.
 *
 * Rules:
 *   - Only `role: "user"` messages get stamped. Assistant messages are
 *     authored by the model and already carry their own provenance.
 *   - If a user message already has `metadata.author`, leave it alone.
 *     This makes re-stamping idempotent (matters for tool continuations).
 *   - Never mutate the input — return a new array.
 */

export type { ChatAuthor } from "@app/shared";
import type { ChatAuthor } from "@app/shared";

interface ChatMessage {
  id?:       string;
  role:      string;
  parts:     unknown[];
  metadata?: Record<string, unknown>;
}

export function stampAuthor<M extends ChatMessage>(
  messages: readonly M[],
  author:   ChatAuthor,
): M[] {
  const now = Date.now();
  return messages.map(m => {
    if (m.role !== "user") return m;
    if (m.metadata && "author" in m.metadata) return m;
    return {
      ...m,
      metadata: {
        ...(m.metadata ?? {}),
        author,
        createdAt: (m.metadata?.createdAt as number | undefined) ?? now,
      },
    };
  });
}

// ---- helpers used by Agent DO hooks ----

/**
 * Extract a `ChatAuthor` from a WS upgrade request's identity headers.
 * Returns null when the headers aren't present (legacy client or dev tool).
 * Pure — takes a Request, never touches DO state.
 */
export function extractAuthorFromUpgradeRequest(
  request: Request,
  readIdentity: (req: Request) => { userId: string; email: string; name: string } | null,
): ChatAuthor | null {
  const id = readIdentity(request);
  if (!id) return null;
  return { kind: "user", id: id.userId, email: id.email, name: id.name };
}

/**
 * Parse a raw WS frame, stamp every embedded user message with the given
 * author, and return the re-serialized frame. Non-chat frames and malformed
 * JSON pass through unchanged.
 *
 * Returning the original `raw` on the no-op path means callers can blindly
 * use the return value as the new `message`.
 */
export function stampChatFrame(raw: string, author: ChatAuthor | null | undefined): string {
  if (!author) return raw;
  let data: { type?: unknown; init?: { body?: unknown } };
  try { data = JSON.parse(raw); }
  catch { return raw; }
  if (data?.type !== "cf_agent_use_chat_request") return raw;
  if (typeof data.init?.body !== "string") return raw;

  let body: { messages?: unknown };
  try { body = JSON.parse(data.init.body); }
  catch { return raw; }
  if (!Array.isArray(body.messages)) return raw;

  const stamped = stampAuthor(body.messages as Array<{ role: string; parts: unknown[]; metadata?: Record<string, unknown> }>, author);
  return JSON.stringify({
    ...data,
    init: { ...data.init, body: JSON.stringify({ ...body, messages: stamped }) },
  });
}
