/**
 * Pure computation of a bulk pull from the container's in-memory Vfs.
 *
 * Pulled out of server.ts's ContainerRpc class so it can be unit-tested
 * without spinning up FUSE / WebSocket / capnweb.  The class is a thin
 * wrapper that turns the returned Buffer into a ReadableStream over the
 * wire.
 */

import type { Vfs } from "./vfs.js";
import {
  CHUNK_SIZE,
  type ManifestBulk,
  type ManifestChange,
  type ManifestChunk,
  type VfsChange,
  type VfsChangeLite,
  type VfsChunkRef,
} from "../shared/index.js";
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

// ---- : manifest-aware pull --------------------------

/**
 * Compute the manifest-aware pull from a container Vfs. Same selection
 * as `computeBulkPull` (rev > sinceRev, plus tombstones), but every
 * file entry carries `chunks: (hash, size)[]` from the container's
 * per-chunk hash index instead of inline bytes. The caller (DO side)
 * follows up with `hasBlobs` + `getBlobs` to fetch only the byte slices
 * it doesn't already have.
 *
 * `maxRev` semantics match `computeBulkPull`.
 */
export function computeManifestPull(
  vfs: Vfs,
  sinceRev: number,
  ignore?: string[],
): ManifestBulk {
  const isIgnored = makeIgnore(ignore);
  type Entry = { rev: number; change: ManifestChange };
  const entries: Entry[] = [];

  for (const { path, node } of vfs.allFiles()) {
    if (node.type === "symlink") continue;  // wire format doesn't carry symlinks yet
    if (node.rev <= sinceRev) continue;
    if (isIgnored(path)) continue;
    if (node.type !== "file") {
      entries.push({
        rev: node.rev,
        change: { seq: 0, path, op: "upsert", type: "dir", mode: node.mode, mtime: node.mtime },
      });
      continue;
    }
    // File: ask the Vfs for its per-chunk hash view. The hashes are
    // computed lazily on first read of any dirty slot — see
    // vfs.chunkHashes().
    const hashes = vfs.chunkHashes(path);
    const chunks: ManifestChunk[] = hashes.map((hash, idx) => ({
      hash,
      size: chunkSizeAt(node.size, idx),
    }));
    entries.push({
      rev: node.rev,
      change: { seq: 0, path, op: "upsert", type: "file", mode: node.mode, mtime: node.mtime, chunks },
    });
  }
  for (const { path, rev, ts } of vfs.getTombstones(sinceRev)) {
    if (isIgnored(path)) continue;
    entries.push({
      rev,
      change: { seq: 0, path, op: "delete", mtime: ts },
    });
  }
  entries.sort((a, b) => a.rev - b.rev);
  const changes: ManifestChange[] = entries.map((e, i) => ({ ...e.change, seq: i }));
  return { changes, maxRev: vfs.currentRev() };
}

/**
 * Compute the byte length of chunk `idx` for a file of `size` bytes.
 * All chunks are CHUNK_SIZE except the last one, which is the tail.
 */
function chunkSizeAt(size: number, idx: number): number {
  const numChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  if (idx < numChunks - 1) return CHUNK_SIZE;
  // Last chunk: file size minus all prior full chunks. Empty files
  // have one zero-length chunk.
  return size - (numChunks - 1) * CHUNK_SIZE;
}

/**
 * Return the byte slices for each requested hash, in request order.
 * The hash → bytes lookup walks the Vfs's per-file chunk-hash index;
 * because identical content shares hashes, the first match wins.
 *
 * Throws if any requested hash isn't held by the Vfs. Callers must
 * dedupe and probe via hasBlobs() first.
 */
export function getBlobs(vfs: Vfs, hashes: Uint8Array[]): Buffer[] {
  // Build a one-shot hash → (path, idx) index. Cheap relative to the
  // request scope and avoids quadratic scans for multi-hash requests.
  const index = new Map<string, { path: string; idx: number }>();
  for (const { path, node } of vfs.allFiles()) {
    if (node.type !== "file") continue;
    const hs = vfs.chunkHashes(path);
    for (let i = 0; i < hs.length; i++) {
      const key = hashKey(hs[i]);
      if (!index.has(key)) index.set(key, { path, idx: i });
    }
  }
  const out: Buffer[] = [];
  for (const h of hashes) {
    const hit = index.get(hashKey(h));
    if (!hit) throw new Error(`getBlobs: unknown hash ${Buffer.from(h).toString("hex")}`);
    out.push(readChunkBytes(vfs, hit.path, hit.idx));
  }
  return out;
}

/**
 * Return the subset of `hashes` the container does NOT have. Helper
 * for the wire-level dedup probe (manifest-aware pull, piece 3).
 */
export function missingBlobs(vfs: Vfs, hashes: Uint8Array[]): Uint8Array[] {
  const have = new Set<string>();
  for (const { path, node } of vfs.allFiles()) {
    if (node.type !== "file") continue;
    for (const h of vfs.chunkHashes(path)) have.add(hashKey(h));
  }
  return hashes.filter(h => !have.has(hashKey(h)));
}

function hashKey(h: Uint8Array): string {
  return Buffer.from(h).toString("latin1");  // raw 32-byte string key
}

function readChunkBytes(vfs: Vfs, path: string, idx: number): Buffer {
  const node = vfs.get(path);
  if (!node || node.type !== "file") throw new Error(`readChunkBytes: not a file: ${path}`);
  const start = idx * CHUNK_SIZE;
  const end   = Math.min(node.size, start + CHUNK_SIZE);
  return node.buf.slice(start, end);
}
