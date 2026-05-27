/**
 * Per-path dirty-chunk tracker for the chunk-sync pull.
 *
 * Two states per path:
 *
 *   - **Whole-file dirty** — recorded by `recordWholeFile()` when the
 *     file was replaced wholesale (cp, tar x, Vfs.putFile).  The pull
 *     must ship every chunk; `isWholeFile()` returns true.
 *   - **Range dirty** — recorded by `recordRange(offset, length)` from
 *     the FUSE write callback.  The pull may ship only the touched
 *     chunks; `dirtyChunkIndexes()` returns the sorted set.
 *
 * The two states are mutually exclusive: once a path is whole-file
 * dirty, further range writes don't downgrade it back to chunk mode —
 * the whole file is going on the wire anyway.
 *
 * State is in-memory only.  Container restart wipes everything, which
 * is correct: a fresh container has no bytes the DO doesn't already
 * have, so the next pull either finds nothing dirty (mtime <= since) or
 * sees real writes that the new tracker can record from the start.
 */

import { CHUNK_SIZE } from "../shared/index.js";

interface PathState {
  /** Chunks touched by range writes since the last clear(). */
  chunks: Set<number>;
  /** True if the path has been replaced wholesale since the last clear(). */
  whole: boolean;
}

export class DirtyRanges {
  private paths = new Map<string, PathState>();

  /** True iff the path has any dirty state (range or whole-file). */
  dirtyChunks(path: string): boolean {
    const s = this.paths.get(path);
    return !!s && (s.whole || s.chunks.size > 0);
  }

  /** True iff the path is in whole-file dirty mode. */
  isWholeFile(path: string): boolean {
    return this.paths.get(path)?.whole === true;
  }

  /**
   * Snapshot of the dirty chunk indexes for a path.  Returns an empty
   * Set when nothing is dirty OR when the path is whole-file dirty
   * (callers must branch on `isWholeFile()` first).  Modifying the
   * returned Set must not affect the tracker.
   */
  dirtyChunkIndexes(path: string): Set<number> {
    const s = this.paths.get(path);
    if (!s || s.whole) return new Set();
    return new Set(s.chunks);
  }

  /**
   * Record a byte-range write.  Empty writes (length 0) are no-ops.
   * Writes against a path already in whole-file mode are ignored.
   */
  recordRange(path: string, offset: number, length: number): void {
    if (length <= 0) return;
    const s = this.getOrCreate(path);
    if (s.whole) return;
    const first = Math.floor(offset / CHUNK_SIZE);
    // `offset + length - 1` is the index of the *last* byte the write
    // touches.  A write ending exactly on a chunk boundary therefore
    // does NOT spill into the next chunk.
    const last  = Math.floor((offset + length - 1) / CHUNK_SIZE);
    for (let i = first; i <= last; i++) s.chunks.add(i);
  }

  /**
   * Mark `path` as wholly replaced.  Subsequent range writes against
   * the same path stay in whole-file mode until `clear()` is called.
   */
  recordWholeFile(path: string): void {
    const s = this.getOrCreate(path);
    s.whole = true;
    s.chunks.clear();
  }

  /** Wipe a single path. */
  clear(path: string): void {
    this.paths.delete(path);
  }

  /** Wipe every path. */
  clearAll(): void {
    this.paths.clear();
  }

  /** Iterate every path that currently has dirty state. */
  listPaths(): Iterable<string> {
    return this.paths.keys();
  }

  // ---- internal ----

  private getOrCreate(path: string): PathState {
    let s = this.paths.get(path);
    if (!s) {
      s = { chunks: new Set(), whole: false };
      this.paths.set(path, s);
    }
    return s;
  }
}
