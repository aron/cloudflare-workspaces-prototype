/**
 * Auto-collapse window for assistant-turn parts.
 *
 * The thread panel renders reasoning and tool boxes that each have
 * their own collapsible body. With long agent turns those boxes pile
 * up and the user loses sight of what's streaming right now: the
 * latest tool's stdout, the latest reasoning chunk. We keep a sliding
 * window of the last N collapsible parts open by default and auto-
 * close everything older.
 *
 * Definitions:
 *
 *   - A "collapsible part" is a message part whose type is
 *     "reasoning" or any AI-SDK tool UI part (`tool-<name>`). Plain
 *     text parts don't have a body to collapse, and the custom
 *     `ExecToolView` isn't a Collapsible at all — its body is always
 *     on. Those are excluded.
 *
 *   - Order matches render order: assistant messages in array order,
 *     parts in array order within each message.
 *
 *   - The "key" for a part is `${messageId}:${partIndex}`. Stable
 *     across renders as long as the message id and the part index
 *     don't change, which the AI SDK guarantees within a single
 *     turn's streaming.
 *
 * The helper is intentionally a pure function over the rendered
 * shape so we don't have to thread auto-collapse state through React
 * context or refs — it's just a `Set` the render loop consults.
 */

/** Minimum shape we need to identify collapsible parts. */
export interface CollapsibleMessage {
  id: string;
  role: string;
  parts: ReadonlyArray<{ type: string }>;
}

/**
 * Build the set of part keys that should be left open. Returns the
 * last `windowSize` collapsible parts across all assistant messages,
 * in render order.
 *
 * `windowSize` of 0 returns an empty set (everything closes).
 * Negative values are treated as 0.
 */
export function collapsibleWindow(
  messages: ReadonlyArray<CollapsibleMessage>,
  windowSize: number,
): Set<string> {
  const open = new Set<string>();
  if (windowSize <= 0) return open;

  // Walk in reverse order so we can stop as soon as we've found
  // `windowSize` parts. Avoids building the full list of keys when
  // we only need the tail.
  for (let mi = messages.length - 1; mi >= 0 && open.size < windowSize; mi--) {
    const m = messages[mi];
    if (m.role !== "assistant") continue;
    for (let pi = m.parts.length - 1; pi >= 0 && open.size < windowSize; pi--) {
      const part = m.parts[pi];
      if (isCollapsiblePart(part.type)) {
        open.add(`${m.id}:${pi}`);
      }
    }
  }
  return open;
}

/**
 * Whether a part type renders as a collapsible box in the thread
 * panel. Exported so the renderer can early-return for non-
 * collapsible parts without duplicating the predicate.
 */
export function isCollapsiblePart(type: string): boolean {
  // AI SDK tool parts come through with `type` starting with
  // `tool-`. We treat all of them as collapsible *except* exec,
  // which has its own always-on chrome.
  if (type === "reasoning") return true;
  if (type === "tool-exec") return false;
  if (type.startsWith("tool-")) return true;
  return false;
}

/**
 * Build the stable key for a part within a message. Centralised so
 * the renderer and the window helper can't drift apart on key shape.
 */
export function partKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`;
}
