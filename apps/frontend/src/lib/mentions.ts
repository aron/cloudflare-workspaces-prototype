/**
 * Pure helpers for the `@mention` UI.
 *
 * Two responsibilities:
 *   1. Tokenize a chunk of free text into alternating `text` and `mention`
 *      runs so renderers can pill-style the latter.
 *   2. Inspect a textarea's current value + caret position to decide
 *      whether the user is mid-mention, and if so, which prefix is being
 *      typed. The composer feeds that prefix to its autocomplete filter.
 *
 * Both functions are caret/cursor agnostic above the DOM layer — they
 * operate on strings and numbers, so they're trivial to unit-test.
 *
 * A "handle" here is the part after `@`. We accept the same character
 * class the backend persona matcher accepts: letters, digits, `._-`.
 * That matches `extractMentions` in apps/agent/src/mentions.ts (kept
 * intentionally permissive so future @user handles fit too).
 */

/** Character class used for handle bodies. Matches `[a-z0-9._-]`. */
const HANDLE_CHAR = /[a-z0-9._-]/i;

/** Full handle regex used for tokenization. */
const MENTION_RE = /@([a-z0-9][a-z0-9._-]{0,63})/gi;

export interface MentionRun {
  type:   "mention";
  /** The raw matched text including the leading `@`. */
  raw:    string;
  /** The handle without the `@`, lowercased. */
  handle: string;
}

export interface TextRun {
  type: "text";
  text: string;
}

export type Run = TextRun | MentionRun;

/**
 * Split `text` into runs. Mentions that don't appear in `known` (lowercased
 * set of valid handles) are emitted as plain text — we don't want random
 * `@symbols` lighting up.
 *
 * If `known` is omitted, every well-formed `@handle` token is treated as a
 * mention. Handy for tests; production callers always pass a set.
 */
export function tokenize(text: string, known?: ReadonlySet<string>): Run[] {
  if (!text) return [];
  const out: Run[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start  = m.index ?? 0;
    const raw    = m[0]!;
    const handle = m[1]!.toLowerCase();
    if (known && !known.has(handle)) continue;
    if (start > lastIndex) {
      out.push({ type: "text", text: text.slice(lastIndex, start) });
    }
    out.push({ type: "mention", raw, handle });
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    out.push({ type: "text", text: text.slice(lastIndex) });
  }
  return out;
}

export interface ActiveMention {
  /** Index of the `@` in the source string. */
  start:  number;
  /** Exclusive end index (== caret position). */
  end:    number;
  /** Lowercased handle prefix typed so far. May be empty. */
  prefix: string;
}

/**
 * Inspect `text` + `caret` and decide whether the caret is parked inside a
 * mention being typed. Returns null if not. A "mention being typed" means:
 *
 *   - the most recent `@` before the caret is preceded by start-of-string
 *     or whitespace (so emails like `me@example.com` don't trigger), AND
 *   - every character between that `@` and the caret matches the handle
 *     character class (so a stray space cancels the popover).
 *
 * The returned `prefix` is the bit between `@` and the caret, lowercased.
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret < 1 || caret > text.length) return null;
  // Walk backwards from the caret looking for the most recent `@`. Stop
  // early if we hit a character that can't appear inside a handle.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") break;
    if (!HANDLE_CHAR.test(ch)) return null;
    i--;
  }
  if (i < 0 || text[i] !== "@") return null;

  // The `@` must be at start-of-string or preceded by whitespace. Otherwise
  // it's an email address or a tag in something the user is quoting.
  const before = i === 0 ? "" : text[i - 1]!;
  if (before && !/\s/.test(before)) return null;

  return {
    start:  i,
    end:    caret,
    prefix: text.slice(i + 1, caret).toLowerCase(),
  };
}

/**
 * Replace the active mention span with `@<handle> ` and return the new text
 * + the caret position to set after the replacement. Pure — caller wires
 * the result into React state.
 */
export function applyMention(
  text:   string,
  active: ActiveMention,
  handle: string,
): { text: string; caret: number } {
  const insert = `@${handle} `;
  const next   = text.slice(0, active.start) + insert + text.slice(active.end);
  return { text: next, caret: active.start + insert.length };
}
