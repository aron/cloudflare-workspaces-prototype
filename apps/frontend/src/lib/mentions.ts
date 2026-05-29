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

/**
 * Token mentions stored on the wire:
 *
 *   <mention type="user"  id="HACKSPACE_USER_ID">@displayhandle</mention>
 *   <mention type="agent" id="AGENT_ID">@agent</mention>
 *
 * The shape is real HTML so Streamdown can let it through sanitisation as
 * a custom element. The label between the tags is for human readers when
 * the message is viewed outside the app (Google Chat, copy-paste); the UI
 * resolves the canonical display from the candidate pool keyed on id.
 *
 * The attribute order is fixed (`type` then `id`) for the regex; the React
 * renderer reads them as props so attribute order doesn't matter there.
 */
const TOKEN_RE = /<mention\s+type="(user|agent)"\s+id="([A-Za-z0-9._-]{1,128})"\s*>([^<]*)<\/mention>/g;

export interface HandleMentionRun {
  type:   "mention";
  /** The raw matched text including the leading `@`. */
  raw:    string;
  /** The handle without the `@`, lowercased. */
  handle: string;
}

export interface RefMentionRun {
  type: "ref";
  /** Full matched token, e.g. `<mention type="user" id="abc">@bob</mention>`. */
  raw:  string;
  kind: "user" | "agent";
  /** The id from the `id="..."` attribute. */
  id:   string;
  /** Inner display label (may be empty). Already plain text, no markup. */
  label: string;
}

export interface TextRun {
  type: "text";
  text: string;
}

export type Run = TextRun | HandleMentionRun | RefMentionRun;

/**
 * Split `text` into runs. Recognises both the on-the-wire token form
 * (`<user:ID>` / `<agent:ID>`) and the user-typed legacy form (`@handle`).
 *
 * `known` (lowercased set of valid handles) gates `@handle` matches so
 * random `@symbols` don't light up. Pass undefined to accept any handle.
 * Token-form refs are always emitted — callers resolve unknown ids to
 * a fallback label at render time.
 */
export function tokenize(text: string, known?: ReadonlySet<string>): Run[] {
  if (!text) return [];
  // Collect matches from both regexes, then walk in order. Two passes is
  // simpler than interleaving two stateful iterators and the strings are
  // short.
  type Hit =
    | { start: number; end: number; run: HandleMentionRun }
    | { start: number; end: number; run: RefMentionRun };
  const hits: Hit[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    hits.push({
      start,
      end: start + m[0]!.length,
      run: {
        type:  "ref",
        raw:   m[0]!,
        kind:  m[1] as "user" | "agent",
        id:    m[2]!,
        label: m[3] ?? "",
      },
    });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    const handle = m[1]!.toLowerCase();
    if (known && !known.has(handle)) continue;
    // Skip handles that overlap a token (e.g. the `@` is inside `<user:@x>`
    // — hypothetical, but cheap to guard).
    if (hits.some(h => start >= h.start && start < h.end)) continue;
    hits.push({
      start,
      end: start + m[0]!.length,
      run: { type: "mention", raw: m[0]!, handle },
    });
  }
  hits.sort((a, b) => a.start - b.start);

  const out: Run[] = [];
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue;  // shouldn't happen post-sort, defensive
    if (h.start > last) out.push({ type: "text", text: text.slice(last, h.start) });
    out.push(h.run);
    last = h.end;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
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

/**
 * Resolver passed by callers to map a `@handle` to a structured ref. Returns
 * null when the handle isn't a known user/agent — in that case the handle
 * stays as plain text in the serialised output.
 */
export type HandleResolver =
  (handle: string) => { kind: "user" | "agent"; id: string } | null;

/**
 * Serialise `@handle` mentions to `<mention type="..." id="...">@handle</mention>`
 * tokens for persistence on the wire. Already-tokenised refs in the input
 * pass through unchanged. Unknown handles (no resolver match) pass through
 * verbatim so the user's literal text is preserved.
 *
 * The inner @handle is a hint for non-app viewers (e.g. Google Chat copy-
 * paste); the UI ignores it and resolves the canonical label from the id.
 */
export function serializeMentions(text: string, resolve: HandleResolver): string {
  const runs = tokenize(text);
  let out = "";
  for (const r of runs) {
    if (r.type === "text") { out += r.text; continue; }
    if (r.type === "ref")  { out += r.raw;  continue; }
    const ref = resolve(r.handle);
    out += ref
      ? `<mention type="${ref.kind}" id="${ref.id}">@${r.handle}</mention>`
      : r.raw;
  }
  return out;
}
