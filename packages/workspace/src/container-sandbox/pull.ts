/**
 * Pure computation of a bulk pull from the container's in-memory Vfs.
 *
 * Pulled out of server.ts's ContainerRpc class so it can be unit-tested
 * without spinning up FUSE / WebSocket / capnweb.  The class is a thin
 * wrapper that turns the returned Buffer into a ReadableStream over the
 * wire.
 */

import type { Vfs } from "./vfs.js";
import type { VfsChange, VfsChangeLite } from "../shared/index.js";
import { makeIgnore } from "./ignore.js";

/**
 * Bulk-pull return shape with the blob still as a contiguous Buffer.
 * Callers wrap it in a ReadableStream as the final step.
 */
export interface BulkPullResult {
  changes: VfsChangeLite[];
  blob:    Buffer;
}

/**
 * Walk every dirty (mtime > since) node and every tombstone past `since`
 * in the Vfs, drop anything matching `ignore`, sort by mtime, lay out
 * the file content into a single Buffer, and emit one VfsChangeLite per
 * entry naming its (offset, size) slice.
 */
export function computeBulkPull(
  vfs: Vfs,
  since: number,
  ignore?: string[],
): BulkPullResult {
  const isIgnored = makeIgnore(ignore);
  type Entry = { ts: number; change: VfsChangeLite; buf?: Buffer };
  const entries: Entry[] = [];

  for (const { path, node } of vfs.allFiles()) {
    if (node.type === "symlink") continue;
    if (node.mtime <= since) continue;
    if (isIgnored(path)) continue;
    if (node.type === "file") {
      const buf = node.buf.slice(0, node.size);
      entries.push({
        ts: node.mtime,
        change: { seq: 0, path, op: "upsert", type: "file", mode: node.mode, mtime: node.mtime, contentOffset: 0, contentSize: buf.length },
        buf,
      });
    } else {
      entries.push({
        ts: node.mtime,
        change: { seq: 0, path, op: "upsert", type: "dir", mode: node.mode, mtime: node.mtime },
      });
    }
  }
  for (const { path, ts } of vfs.getTombstones(since)) {
    if (isIgnored(path)) continue;
    entries.push({ ts, change: { seq: 0, path, op: "delete", mtime: ts } });
  }
  entries.sort((a, b) => a.ts - b.ts);

  // Lay out the blob: walk entries in order, assign offsets, accumulate
  // a single Buffer.  Files >0 bytes carry their slice; dirs/deletes
  // contribute nothing.
  const fileEntries = entries.filter(e => e.buf !== undefined);
  const totalBytes = fileEntries.reduce((n, e) => n + (e.buf!.length), 0);
  const blob = Buffer.allocUnsafe(totalBytes);
  let off = 0;
  for (const e of fileEntries) {
    e.change.contentOffset = off;
    e.change.contentSize = e.buf!.length;
    e.buf!.copy(blob, off);
    off += e.buf!.length;
  }

  const changes: VfsChangeLite[] = entries.map((e, i) => ({ ...e.change, seq: i }));
  return { changes, blob };
}

/**
 * Streaming variant of the old getDirtyNodes wire format, computed from
 * the same Vfs.  Pulled out for the same testability reason.
 */
export function computeDirtyNodes(
  vfs: Vfs,
  since: number,
  ignore?: string[],
): Array<{ change: VfsChange; bytes?: Buffer }> {
  const isIgnored = makeIgnore(ignore);
  type Entry = { ts: number; change: Omit<VfsChange, "content">; bytes?: Buffer };
  const upserts: Entry[] = [];
  for (const { path, node } of vfs.allFiles()) {
    if (node.type === "symlink") continue;
    if (node.mtime <= since) continue;
    if (isIgnored(path)) continue;
    upserts.push({
      ts: node.mtime,
      change: {
        seq: 0, path, op: "upsert", type: node.type as "file" | "dir",
        mode: node.mode, mtime: node.mtime,
      },
      bytes: node.type === "file" ? node.buf.slice(0, node.size) : undefined,
    });
  }
  const tombs: Entry[] = vfs.getTombstones(since)
    .filter(({ path }) => !isIgnored(path))
    .map(({ path, ts }) => ({
      ts,
      change: { seq: 0, path, op: "delete", mtime: ts },
    }));
  const merged = [...upserts, ...tombs].sort((a, b) => a.ts - b.ts);
  return merged.map((e, i) => ({
    change: { ...e.change, seq: i },
    bytes: e.bytes,
  }));
}
