import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { type ChangeEntry, materialiseChange } from "./changes.js";
import { isIgnored } from "./ignore.js";

// Walk vfs_dirents from `inode` up to ROOT_INODE, gathering the path
// segments along the way. Returns null when the inode is unreachable
// (orphan after a partially-applied rm; should not happen inside a
// healthy DB but the caller treats null as "skip this entry").
function pathOf(db: Database, inode: number): string | null {
  if (inode === ROOT_INODE) return "/";
  const segments: string[] = [];
  let current = inode;
  // Bound the walk: a million levels deep is well past any real FS;
  // anything beyond that is corruption and should not loop forever.
  for (let i = 0; i < 1_000_000; i++) {
    const row = db.one<{ parent_inode: number; name: string }>(
      "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
      current,
    );
    if (row === undefined) return null;
    segments.push(row.name);
    if (row.parent_inode === ROOT_INODE) {
      segments.reverse();
      return `/${segments.join("/")}`;
    }
    current = row.parent_inode;
  }
  return null;
}

// Yield one ChangeEntry per path touched since `sinceRev`. Per-path
// coalescing: five rewrites of the same path between watermarks
// produce one entry (the latest state wins). Tombstoned paths get a
// delete entry unless they have been recreated, in which case the
// live entry wins.
//
// Streaming, not buffering: we walk vfs_nodes by rev index and
// vfs_changes by path, yielding as we go so callers can pipe into a
// Capnweb stream without holding the whole delta in memory.
export interface CoalesceOptions {
  // Path-segment patterns to drop before yielding. The wire never
  // carries entries under an ignored segment; see docs/02.
  ignore?: string[];
}

export async function* coalesceChanges(
  db: Database,
  sinceRev: number,
  options: CoalesceOptions = {},
): AsyncIterable<ChangeEntry> {
  const ignore = options.ignore ?? [];
  const emitted = new Set<string>();

  // Live mutations: every mkdir / writeFile / symlink bumps
  // vfs_nodes.rev. The by_rev index makes this a range scan.
  const touched = db.all<{ inode: number }>(
    "SELECT inode FROM vfs_nodes WHERE rev > ? ORDER BY rev",
    sinceRev,
  );
  for (const { inode } of touched) {
    const path = pathOf(db, inode);
    if (path === null) continue;
    if (isIgnored(path, ignore)) continue;
    if (emitted.has(path)) continue;
    const entry = materialiseChange(db, path);
    if (entry !== null) {
      emitted.add(path);
      yield entry;
    }
  }

  // Tombstones: each rm appends a row to vfs_changes with the
  // post-bump rev. We only emit a delete if the path has no live
  // inode — materialiseChange already handles that, but we
  // double-check via the emitted set so a recreated path doesn't
  // get a redundant pass.
  const tombs = db.all<{ path: string }>(
    "SELECT DISTINCT path FROM vfs_changes WHERE rev > ? AND op = 'delete'",
    sinceRev,
  );
  for (const { path } of tombs) {
    if (isIgnored(path, ignore)) continue;
    if (emitted.has(path)) continue;
    const entry = materialiseChange(db, path);
    if (entry !== null) {
      emitted.add(path);
      yield entry;
    }
  }
}
