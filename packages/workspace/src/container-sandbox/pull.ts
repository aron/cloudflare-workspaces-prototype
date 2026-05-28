/**
 * Pure computation of a bulk pull from the container's in-memory Vfs.
 *
 * Pulled out of server.ts's ContainerRpc class so it can be unit-tested
 * without spinning up FUSE / WebSocket / capnweb.  The class is a thin
 * wrapper that turns the returned Buffer into a ReadableStream over the
 * wire.
 */

import type { Vfs } from "./vfs.js";
import { CHUNK_SIZE, type VfsChange, type VfsChangeLite, type VfsChunkRef } from "../shared/index.js";
import { makeIgnore } from "./ignore.js";

/**
 * Bulk-pull return shape with the blob still as a contiguous Buffer.
 * Callers wrap it in a ReadableStream as the final step.
 *
 * `maxRev` is the revision the receiver should adopt as its new
 * watermark. It equals `sinceRev` when nothing changed and `vfs.currentRev()`
 * when changes were collected; either way, advancing to `maxRev` after
 * a successful apply means the next pull starts strictly after this one.
 */
export interface BulkPullResult {
  changes: VfsChangeLite[];
  blob:    Buffer;
  maxRev:  number;
}

/**
 * Walk every dirty (rev > sinceRev) node and every tombstone past `sinceRev`
 * in the Vfs, drop anything matching `ignore`, sort by rev, lay out the
 * file content into a single Buffer, and emit one VfsChangeLite per entry
 * naming its (offset, size) slice. Returns `maxRev` so the receiver can
 * advance its watermark even when nothing was selected (empty pull).
 */
export function computeBulkPull(
  vfs: Vfs,
  sinceRev: number,
  ignore?: string[],
): BulkPullResult {
  const isIgnored = makeIgnore(ignore);
  // An entry is either a directory (no bytes), a delete (no bytes), a
  // whole-file file (carries one Buffer slice), or a chunk-mode file
  // (carries one Buffer per dirty chunk plus the chunk indexes).
  // `rev` orders entries deterministically; same-millisecond mtimes
  // are no longer a source of ambiguity.
  type Entry =
    | { rev: number; change: VfsChangeLite; kind: "meta" }
    | { rev: number; change: VfsChangeLite; kind: "whole"; buf: Buffer }
    | { rev: number; change: VfsChangeLite; kind: "chunks"; chunks: Array<{ idx: number; buf: Buffer }> };
  const entries: Entry[] = [];

  for (const { path, node } of vfs.allFiles()) {
    if (node.type === "symlink") continue;
    if (node.rev <= sinceRev) continue;
    if (isIgnored(path)) continue;
    if (node.type !== "file") {
      entries.push({
        rev: node.rev,
        kind: "meta",
        change: { seq: 0, path, op: "upsert", type: "dir", mode: node.mode, mtime: node.mtime },
      });
      continue;
    }
    // File: chunk-mode iff the dirty tracker says "range-dirty, not
    // whole-file dirty."  In every other case (brand-new file, whole
    // replace, dirty tracker empty -> still in rev range, fall back
    // to whole-file to be safe), ship the whole file.
    const buf = node.buf.slice(0, node.size);
    if (vfs.dirty.dirtyChunks(path) && !vfs.dirty.isWholeFile(path)) {
      const idxs = [...vfs.dirty.dirtyChunkIndexes(path)].sort((a, b) => a - b);
      const chunks: Array<{ idx: number; buf: Buffer }> = [];
      for (const idx of idxs) {
        const start = idx * CHUNK_SIZE;
        if (start >= buf.length) continue;  // dirty chunk past EOF: skip (truncate caught upstream)
        const end = Math.min(buf.length, start + CHUNK_SIZE);
        chunks.push({ idx, buf: buf.slice(start, end) });
      }
      entries.push({
        rev: node.rev,
        kind: "chunks",
        change: { seq: 0, path, op: "upsert", type: "file", mode: node.mode, mtime: node.mtime },
        chunks,
      });
    } else {
      entries.push({
        rev: node.rev,
        kind: "whole",
        change: { seq: 0, path, op: "upsert", type: "file", mode: node.mode, mtime: node.mtime },
        buf,
      });
    }
  }
  for (const { path, rev, ts } of vfs.getTombstones(sinceRev)) {
    if (isIgnored(path)) continue;
    entries.push({
      rev,
      kind: "meta",
      change: { seq: 0, path, op: "delete", mtime: ts },
    });
  }
  entries.sort((a, b) => a.rev - b.rev);

  // Lay out the blob: every whole-file slice and every chunk slice in
  // entry order.  contentOffset / chunks[].offset are filled in as we
  // copy bytes.
  let totalBytes = 0;
  for (const e of entries) {
    if (e.kind === "whole")  totalBytes += e.buf.length;
    if (e.kind === "chunks") for (const k of e.chunks) totalBytes += k.buf.length;
  }
  const blob = Buffer.allocUnsafe(totalBytes);
  let off = 0;
  for (const e of entries) {
    if (e.kind === "whole") {
      e.change.contentOffset = off;
      e.change.contentSize   = e.buf.length;
      e.buf.copy(blob, off);
      off += e.buf.length;
    } else if (e.kind === "chunks") {
      const refs: VfsChunkRef[] = [];
      for (const k of e.chunks) {
        k.buf.copy(blob, off);
        refs.push({ idx: k.idx, offset: off, size: k.buf.length });
        off += k.buf.length;
      }
      e.change.chunks = refs;
    }
  }

  const changes: VfsChangeLite[] = entries.map((e, i) => ({ ...e.change, seq: i }));
  // Always surface the current rev so the receiver can advance its
  // watermark even on an empty pull. Receiver semantics: adopt maxRev
  // after a successful apply.
  return { changes, blob, maxRev: vfs.currentRev() };
}

/**
 * Streaming variant of the old getDirtyNodes wire format, computed from
 * the same Vfs.  Pulled out for the same testability reason.
 */
export function computeDirtyNodes(
  vfs: Vfs,
  sinceRev: number,
  ignore?: string[],
): Array<{ change: VfsChange; bytes?: Buffer }> {
  const isIgnored = makeIgnore(ignore);
  type Entry = { rev: number; change: Omit<VfsChange, "content">; bytes?: Buffer };
  const upserts: Entry[] = [];
  for (const { path, node } of vfs.allFiles()) {
    if (node.type === "symlink") continue;
    if (node.rev <= sinceRev) continue;
    if (isIgnored(path)) continue;
    upserts.push({
      rev: node.rev,
      change: {
        seq: 0, path, op: "upsert", type: node.type as "file" | "dir",
        mode: node.mode, mtime: node.mtime,
      },
      bytes: node.type === "file" ? node.buf.slice(0, node.size) : undefined,
    });
  }
  const tombs: Entry[] = vfs.getTombstones(sinceRev)
    .filter(({ path }) => !isIgnored(path))
    .map(({ path, rev, ts }) => ({
      rev,
      change: { seq: 0, path, op: "delete" as const, mtime: ts },
    }));
  const merged = [...upserts, ...tombs].sort((a, b) => a.rev - b.rev);
  return merged.map((e, i) => ({
    change: { ...e.change, seq: i },
    bytes: e.bytes,
  }));
}
