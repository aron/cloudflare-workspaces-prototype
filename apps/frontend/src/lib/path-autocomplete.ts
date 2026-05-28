/**
 * Pure helpers backing the !/ path-autocomplete popover.
 *
 * Kept separate from the React component so the popover stays thin
 * (rendering + keyboard nav only) and the URL/text math is unit-tested.
 */

export interface ListingEntry {
  path: string;
  type: "file" | "dir";
}

const TRIGGER = "!/";

/**
 * Extract the autocomplete query from editor text.
 *
 * The `!/` is a fixed two-char trigger. Everything after it is the
 * query the server interprets:
 *   contains `/`  -> path-prefix walk
 *   no `/`        -> fuzzy match across basenames
 * Returns null when the input isn't in bang mode.
 */
function extractQuery(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(TRIGGER)) return null;
  return trimmed.slice(TRIGGER.length).trimEnd();
}

/** Build the listing endpoint URL for the current editor text. */
export function buildListingUrl(threadId: string, text: string): string | null {
  const query = extractQuery(text);
  if (query === null) return null;
  const params = new URLSearchParams({ prefix: query, limit: "20" });
  return `/api/threads/${threadId}/files-list?${params.toString()}`;
}

/** Apply a selected completion to the current text. */
export function acceptCompletion(
  _text: string,
  entry: ListingEntry,
): { text: string; keepOpen: boolean } {
  // Always rewrite to the canonical "!/<entry.path stripped of leading />"
  // form so the result is a well-formed bang command regardless of what
  // the user typed.
  const path = entry.path;
  if (entry.type === "dir") {
    const withSlash = path.endsWith("/") ? path : `${path}/`;
    return { text: `!${withSlash}`, keepOpen: true };
  }
  return { text: `!${path}`, keepOpen: false };
}

/**
 * Last-mile filter for client-side stability.
 *
 * The server now does the heavy lifting (path-prefix walk OR fzf-style
 * fuzzy match, plus default ignores). When the query is a path prefix
 * we still apply the same filter on the client so that stale results
 * from a previous keystroke don't briefly appear unrelated. For fuzzy
 * queries we just trust the server's ordering — reranking on the
 * client would require porting the scoring function and is overkill.
 */
export function filterAndRank(
  entries: readonly ListingEntry[],
  query: string,
): ListingEntry[] {
  // Path-prefix queries: apply the same prefix filter the server did,
  // so stale results from a previous keystroke don't briefly show
  // unrelated entries. Fuzzy queries trust the server's score order.
  if (!query.includes("/")) return [...entries];
  const needle = query.startsWith("/") ? query : `/${query}`;
  const matched = entries.filter((e) => e.path.startsWith(needle));
  matched.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return matched;
}
