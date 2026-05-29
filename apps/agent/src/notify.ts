/**
 * Google Chat webhook delivery for @mention notifications.
 *
 * One responsibility: given a recipient's Google Workspace user ID and some
 * context, POST a "you were mentioned" message to the configured Google
 * Chat incoming-webhook URL.
 *
 * Errors are swallowed (logged only) — a webhook failure must never fail
 * the originating message POST. Callers should still wrap calls in
 * `ctx.waitUntil` so the network round-trip doesn't block the response.
 */

export interface MentionNotice {
  webhookUrl:        string;
  /** Numeric Google Workspace user ID of the recipient. */
  googleChatUserId:  string;
  /** Display name of the recipient. Used in the message body. */
  recipientName:     string;
  /** Display name of the room ("#general"-style label). */
  roomName:          string;
  /** Short excerpt of the mentioning message (already trimmed). */
  snippet:           string;
  /** Absolute or app-relative URL pointing back at the room/thread. */
  roomUrl?:          string;
}

/** Cap the snippet so we don't dump a wall of text into the chat space. */
const SNIPPET_MAX = 240;

/**
 * Trim, collapse whitespace, strip Hackspace `<mention …>` tags down to
 * their inner `@handle` text, and clip to {@link SNIPPET_MAX}. Returns an
 * empty string when the input has no visible content.
 *
 * Stripping the tags matters for two reasons:
 *   1. Google Chat treats `<...>` in the `text` field as a special
 *      reference (e.g. `<users/123>`). Unrecognised shapes — including
 *      our literal `<mention …>` — cause the webhook to 500.
 *   2. The notification recipient sees a clean “@bob” in the snippet,
 *      not a wall of HTML.
 */
export function buildSnippet(text: string): string {
  const stripped = text.replace(
    /<mention\s+type="(?:user|agent)"\s+id="[A-Za-z0-9._-]{1,128}"\s*>([^<]*)<\/mention>/g,
    (_match, label: string) => label.trim() || "@user",
  );
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length <= SNIPPET_MAX ? cleaned : cleaned.slice(0, SNIPPET_MAX - 1) + "…";
}

/**
 * Build the JSON payload sent to Google Chat. Exported for testability —
 * the production path goes through {@link sendGChatMention}.
 */
export function buildPayload(n: MentionNotice): { text: string } {
  const mention = `<users/${n.googleChatUserId}>`;
  const lines = [`${mention} ${n.recipientName} was mentioned in the Hackspace (${n.roomName})`];
  if (n.snippet) lines.push(`> ${n.snippet}`);
  if (n.roomUrl) lines.push(n.roomUrl);
  return { text: lines.join("\n") };
}

/**
 * Fire-and-forget POST to the webhook. Never throws — failures are logged.
 * Returns true when the webhook accepted the message (2xx), false otherwise.
 */
export async function sendGChatMention(n: MentionNotice): Promise<boolean> {
  try {
    const res = await fetch(n.webhookUrl, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(buildPayload(n)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[notify] gchat webhook ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[notify] gchat webhook failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Extract Hackspace user ids from `<mention type="user" id="...">...</mention>`
 * tokens in a message body. Returns unique ids in stable order.
 */
export function extractMentionedUserIds(text: string): string[] {
  const out = new Set<string>();
  const re = /<mention\s+type="user"\s+id="([A-Za-z0-9._-]{1,128})"\s*>[^<]*<\/mention>/g;
  for (const m of text.matchAll(re)) {
    out.add(m[1]!);
  }
  return [...out];
}
