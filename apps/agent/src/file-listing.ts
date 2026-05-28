/**
 * Pure helper for the autocomplete listing endpoint.
 *
 * Inputs are minimal so unit tests don't need a real VFS. The Agent's
 * onRequest handler is responsible for translating a Workspace snapshot
 * into ListingEntry[] and calling this function.
 */

export interface ListingEntry {
  path: string;
  type: "file" | "dir";
}

export interface ListingResult {
  entries: ListingEntry[];
}

export function buildListing(
  all: readonly ListingEntry[],
  prefix: string,
  limit: number,
): ListingResult {
  const matched = all.filter((e) => e.path.startsWith(prefix));
  matched.sort((a, b) => {
    // Directories first.
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return { entries: matched.slice(0, Math.max(0, limit)) };
}
