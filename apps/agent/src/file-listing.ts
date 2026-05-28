/**
 * Pure helper for the autocomplete listing endpoint.
 *
 * Two query modes, chosen by the shape of the input:
 *
 *   1. Path-prefix (query starts with `/`): the user is drilling into
 *      a directory. Walk the tree, keep directories visible so Tab can
 *      append a slash and keep going, sort dirs first then alphabetical.
 *
 *   2. Fuzzy (anything else): subsequence match against the basename
 *      first, fall back to the full path. fzf-style scoring — bonuses
 *      for start-of-basename, word boundaries, consecutive characters.
 *
 * Default ignores filter `node_modules` and `.git` out of both modes
 * so an `npm install` doesn't drown the popover.
 *
 * Inputs are minimal so unit tests don't need a real VFS. The Agent's
 * onRequest handler is responsible for translating a Workspace
 * snapshot into ListingEntry[] and calling this function.
 */

export interface ListingEntry {
  path: string;
  type: "file" | "dir";
}

export interface ListingResult {
  entries: ListingEntry[];
}

export interface BuildListingOptions {
  /**
   * Path segments to exclude from results. Any entry whose path
   * contains a segment in this set is dropped from both modes.
   * Defaults to `["node_modules", ".git"]`.
   */
  ignore?: string[];
}

const DEFAULT_IGNORE = ["node_modules", ".git"];

export function buildListing(
  all: readonly ListingEntry[],
  query: string,
  limit: number,
  options: BuildListingOptions = {},
): ListingResult {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const visible = ignore.size === 0
    ? all
    : all.filter((e) => !pathHasSegment(e.path, ignore));

  // Mode selection by query shape:
  //   contains `/`  -> path-prefix walk (drill into a directory)
  //   no `/`        -> fuzzy across basenames (find a file by name)
  // Empty query falls through to prefix-mode with `""` which matches
  // everything.
  if (query === "" || query.includes("/")) {
    const normalised = query === "" || query.startsWith("/") ? query : `/${query}`;
    return pathPrefixListing(visible, normalised, limit);
  }
  return fuzzyListing(visible, query, limit);
}

function pathHasSegment(path: string, segments: ReadonlySet<string>): boolean {
  for (const seg of path.split("/")) {
    if (segments.has(seg)) return true;
  }
  return false;
}

function pathPrefixListing(
  entries: readonly ListingEntry[],
  prefix: string,
  limit: number,
): ListingResult {
  const matched = entries.filter((e) => e.path.startsWith(prefix));
  matched.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return { entries: matched.slice(0, Math.max(0, limit)) };
}

function fuzzyListing(
  entries: readonly ListingEntry[],
  query: string,
  limit: number,
): ListingResult {
  const lowered = query.toLowerCase();
  const scored: Array<{ entry: ListingEntry; score: number }> = [];

  for (const entry of entries) {
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const baseScore = fuzzyScore(basename.toLowerCase(), lowered);
    const pathScore = fuzzyScore(entry.path.toLowerCase(), lowered);
    // Basename hits are worth more — they're what the user typed against.
    // Combine rather than take max so a file with a great basename and a
    // good path beats one with only a great basename in deep nesting.
    const combined = baseScore * 2 + pathScore;
    if (combined <= 0) continue;
    // Tiny bias so files outweigh dirs at equal score.
    const typeBias = entry.type === "file" ? 1 : 0;
    scored.push({ entry, score: combined * 100 + typeBias });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.path.localeCompare(b.entry.path);
  });

  return {
    entries: scored.slice(0, Math.max(0, limit)).map((s) => s.entry),
  };
}

/**
 * Score how well `query` matches `text` as an ordered subsequence.
 *
 * Both arguments must already be lowercased by the caller. Returns 0
 * when `query` is not a subsequence of `text`; otherwise a positive
 * integer where higher is better.
 *
 * fzf-inspired but trimmed:
 *   - +16 for every matched character (so longer matches outweigh
 *     short ones even when patterns differ)
 *   - +8  when the matched character is at the start of `text`
 *   - +4  when the matched character is at a word boundary
 *     (previous char is one of `/._-` or a digit→letter / lower→upper
 *     transition)
 *   - +4  when the matched character is consecutive with the previous
 *     match (rewards `foo` matching `foo` over `f_o_o`)
 *   - −1 per gap character between matches (light penalty so long
 *     stretchy matches lose to compact ones)
 */
function fuzzyScore(text: string, query: string): number {
  if (query.length === 0) return 0;
  if (query.length > text.length) return 0;

  let score = 0;
  let qi = 0;
  let lastMatch = -2;

  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) continue;

    score += 16;
    if (ti === 0) score += 8;
    if (ti > 0 && isBoundary(text, ti)) score += 4;
    if (ti === lastMatch + 1) score += 4;
    if (lastMatch >= 0) score -= (ti - lastMatch - 1);

    lastMatch = ti;
    qi++;
  }

  if (qi < query.length) return 0;
  return score;
}

function isBoundary(text: string, i: number): boolean {
  const prev = text[i - 1];
  if (prev === "/" || prev === "." || prev === "_" || prev === "-") return true;
  // camelCase / digit-letter transitions. (text is lowercased before we
  // get here, so the camelCase case can't apply; the digit→letter one
  // still does.)
  if (/\d/.test(prev) && /[a-z]/.test(text[i])) return true;
  return false;
}
