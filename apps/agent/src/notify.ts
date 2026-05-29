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
  // The `<users/ID>` reference already renders as a pill with the
  // recipient's name, so we don't restate it. The first line is just the
  // mention plus where the ping came from.
  const lines = [`${mention} mentioned in the Hackspace (${n.roomName})`];
  // Italicise the snippet — Google Chat's text formatting doesn't support
  // `>` blockquotes, but `_text_` renders italic and reads naturally as a
  // quoted excerpt. Underscores inside the snippet are escaped so the
  // formatting span stays a single run.
  if (n.snippet) lines.push(`_${n.snippet.replace(/_/g, "\\_")}_`);
  if (n.roomUrl) lines.push(n.roomUrl);
  return { text: lines.join("\n") };
}

/**
 * Mask sensitive query params on a Google Chat webhook URL while keeping
 * the bits that identify *which* webhook this is (host + space id). Used
 * by the structured logger so the webhook URL can safely land in worker
 * logs / dashboards.
 *
 * Input:  https://chat.googleapis.com/v1/spaces/AAQ.../messages?key=AIzaSy...&token=WByNi3...
 * Output: https://chat.googleapis.com/v1/spaces/AAQ.../messages?key=REDACTED&token=REDACTED
 */
export function redactWebhookUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    for (const k of ["key", "token"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    // Malformed URL — don't leak it. Caller probably has bigger problems.
    return "<invalid-url>";
  }
}

/**
 * Structured log line. We emit one JSON object per call (console.log /
 * console.warn) so wrangler tail and the Workers dashboard can index
 * fields without ad-hoc regex. The shape:
 *
 *   { module: "gchat", message: "...", level: "info" | "warn",
 *     webhook_url?: "<redacted>", ...extra }
 *
 * `webhook_url` is automatically redacted when present. Extra fields are
 * shallow-merged on top — don't pass anything sensitive in `extra`.
 */
export function log(
  level: "info" | "warn",
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const entry: Record<string, unknown> = { module: "gchat", message, level, ...extra };
  if (typeof entry.webhook_url === "string") {
    entry.webhook_url = redactWebhookUrl(entry.webhook_url as string);
  }
  if (level === "warn") console.warn(entry);
  else console.log(entry);
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
      log("warn", "gchat webhook returned non-2xx", {
        webhook_url: n.webhookUrl,
        status:           res.status,
        google_chat_user: n.googleChatUserId,
        room_name:        n.roomName,
        body_preview:     body.slice(0, 200),
      });
      return false;
    }
    log("info", "gchat webhook ok", {
      webhook_url: n.webhookUrl,
      google_chat_user: n.googleChatUserId,
      room_name:        n.roomName,
    });
    return true;
  } catch (e) {
    log("warn", "gchat webhook fetch failed", {
      webhook_url: n.webhookUrl,
      error: (e as Error).message,
    });
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
