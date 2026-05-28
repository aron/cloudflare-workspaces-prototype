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

/** Extract the in-progress path prefix from editor text, or null. */
function extractPrefix(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(TRIGGER)) return null;
  // Keep the leading slash on the path; trim only trailing whitespace
  // so the prefix matches what the server has on disk.
  return trimmed.slice(1).trimEnd();
}

/** Build the listing endpoint URL for the current editor text. */
export function buildListingUrl(threadId: string, text: string): string | null {
  const prefix = extractPrefix(text);
  if (prefix === null) return null;
  const params = new URLSearchParams({ prefix, limit: "20" });
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

/** Client-side filter + rank, in case the server returns stale results. */
export function filterAndRank(
  entries: readonly ListingEntry[],
  prefix: string,
): ListingEntry[] {
  const matched = entries.filter((e) => e.path.startsWith(prefix));
  matched.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return matched;
}
