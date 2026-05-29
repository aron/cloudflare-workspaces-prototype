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
  const stripped = text
    // Current format: <mention type="user|agent" id="...">@label</mention>
    .replace(
      /<mention\s+type="(?:user|agent)"\s+id="[A-Za-z0-9._-]{1,128}"\s*>([^<]*)<\/mention>/g,
      (_match, label: string) => label.trim() || "@user",
    )
    // Legacy format emitted by pre-migration messages and by older agent
    // turns that copied the old style from history. Replace with a generic
    // @user / @agent label so the `<...>` doesn't reach Google Chat.
    .replace(/<user:[A-Za-z0-9._-]{1,128}>/g,  "@user")
    .replace(/<agent:[A-Za-z0-9._-]{1,128}>/g, "@agent");
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length <= SNIPPET_MAX ? cleaned : cleaned.slice(0, SNIPPET_MAX - 1) + "…";
}

/**
 * Pick the most-specific link we can build back to the app. Falls through:
 *
 *   1. Deep-link to a specific message in a thread
 *   2. Deep-link to a specific message in a room
 *   3. Deep-link to the room
 *   4. The app origin (always a working URL when baseUrl is set)
 *
 * Returns undefined only when we have no baseUrl at all — in that case the
 * payload omits the link entirely rather than emit a bare path that won't
 * resolve outside the app.
 */
export function pickRoomUrl(parts: {
  baseUrl?:   string;
  roomId?:    string;
  threadId?:  string;
  messageId?: string;
}): string | undefined {
  const base = (parts.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return undefined;
  const room   = parts.roomId   ?? "";
  const thread = parts.threadId ?? "";
  const msg    = parts.messageId ?? "";
  if (room && thread && msg) return `${base}/rooms/${room}/threads/${thread}#${msg}`;
  if (room && msg)           return `${base}/rooms/${room}#${msg}`;
  if (room)                  return `${base}/rooms/${room}`;
  return base;
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
  // Build the payload once so we can log the exact bytes on failure.
  // Crucial for diagnosing Google's `INTERNAL` 500s, which never tell you
  // which field offended them.
  const payload = buildPayload(n);
  const requestBody = JSON.stringify(payload);
  try {
    const res = await fetch(n.webhookUrl, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    requestBody,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("warn", "gchat webhook returned non-2xx", {
        webhook_url:      n.webhookUrl,
        status:           res.status,
        google_chat_user: n.googleChatUserId,
        room_name:        n.roomName,
        // Full request payload, both as a parsed object (so the dashboard's
        // JSON tree view is readable) and as the literal bytes we POSTed
        // (so we can spot encoding / escaping diffs against curl).
        payload,
        request_body:      requestBody,
        request_body_len:  requestBody.length,
        // Full response body — Google's `details[].fieldViolations[]` array
        // sometimes lives past the first 200 chars and we don't want it
        // truncated when triaging.
        response_body:     body,
        response_body_len: body.length,
      });
      return false;
    }
    log("info", "gchat webhook ok", {
      webhook_url:      n.webhookUrl,
      google_chat_user: n.googleChatUserId,
      room_name:        n.roomName,
    });
    return true;
  } catch (e) {
    log("warn", "gchat webhook fetch failed", {
      webhook_url:  n.webhookUrl,
      payload,
      request_body: requestBody,
      error:        (e as Error).message,
    });
    return false;
  }
}

/**
 * Extract Hackspace user ids from mention tokens in a message body. Accepts
 * both the current `<mention type="user" id="...">@label</mention>` form and
 * the legacy `<user:ID>` form that pre-migration messages and older agent
 * turns emit. Returns unique ids in stable order.
 */
export function extractMentionedUserIds(text: string): string[] {
  const out = new Set<string>();
  const current = /<mention\s+type="user"\s+id="([A-Za-z0-9._-]{1,128})"\s*>[^<]*<\/mention>/g;
  for (const m of text.matchAll(current)) out.add(m[1]!);
  const legacy = /<user:([A-Za-z0-9._-]{1,128})>/g;
  for (const m of text.matchAll(legacy)) out.add(m[1]!);
  return [...out];
}
