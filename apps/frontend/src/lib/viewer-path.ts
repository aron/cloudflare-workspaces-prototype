/**
 * Validate an absolute VFS path the viewer would fetch.
 *
 * Pure. Used by parseBangInput and the autocomplete acceptor so both
 * share one definition of "addressable file path."
 */

export function isValidViewerPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  // Require at least one non-empty segment after the leading slash that
  // isn't only whitespace. `/`, `//`, `/   ` all fail.
  const segments = p.split("/").slice(1); // drop the empty before the first `/`
  if (segments.length === 0) return false;
  if (segments.every((s) => s.trim() === "")) return false;
  if (segments.some((s) => s === "..")) return false;
  return true;
}
