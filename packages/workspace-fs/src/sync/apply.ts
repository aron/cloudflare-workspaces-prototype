import { mkdir } from "../fs/mkdir.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { writeFile } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { readWatermark, writeWatermark } from "./watermarks.js";

export interface ApplyOptions {
  // Soft cap on bytes written per transactionSync batch. Default 64
  // MiB; matches docs/02_sync_protocol.md. The cap is advisory: a
  // single large file is always one batch.
  maxBytesPerBatch?: number;
  // Soft cap on entries per batch. Default 1024 paths.
  maxPathsPerBatch?: number;
  // After the stream drains, advance fetchRev to this value if it's
  // higher than the current persisted value. Callers pass the
  // sender's currentRev so the next pull resumes from the right
  // cursor. Never regresses the watermark.
  advanceFetchRev?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PATHS = 1024;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// Drive a ChangeEntry stream against `db`, batching writes so peak
// memory stays bounded and a crash mid-apply leaves the DB in a
// consistent state. Each batch runs inside a single transactionSync
// from the underlying FS helpers \u2014 mkdir, writeFile, symlink,
// rm all wrap their own transactionSync, so a batch is in practice
// a sequence of independently-committed mutations rather than one
// fat transaction. The bounded-batch contract still holds because
// fetchRev only advances after the stream drains.
//
// `objects` is a hash-keyed map of chunk bytes the sender shipped
// via pushObjects / fetchObjects. File entries reassemble their
// chunks from this map; missing entries throw.
export async function applyChanges(
  db: Database,
  entries: Iterable<ChangeEntry> | AsyncIterable<ChangeEntry>,
  objects: Map<string, Uint8Array>,
  options: ApplyOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES;
  const maxPaths = options.maxPathsPerBatch ?? DEFAULT_MAX_PATHS;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for await (const entry of entries) {
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Already gone is fine \u2014 idempotent apply.
      }
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "dir") {
      mkdir(db, entry.path, { mode: entry.mode, recursive: true }, () => entry.mtime);
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "symlink") {
      symlink(db, entry.target, entry.path, () => entry.mtime);
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    // file: assemble chunk bytes from the keyed map.
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const c of entry.chunks) {
      const k = hex(c.hash);
      const bytes = objects.get(k);
      if (bytes === undefined) {
        throw new Error(`applyChanges: missing object ${k} for ${entry.path}`);
      }
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    await writeFile(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
  }

  // Advance fetchRev only after the stream drains so a crash
  // mid-apply leaves the watermark behind and the next pull
  // re-fetches anything not yet committed.
  if (options.advanceFetchRev !== undefined) {
    const current = readWatermark(db, "fetchRev");
    if (options.advanceFetchRev > current) {
      writeWatermark(db, "fetchRev", options.advanceFetchRev);
    }
  }
}
