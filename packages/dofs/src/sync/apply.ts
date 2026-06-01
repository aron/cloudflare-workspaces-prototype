import { mkdir } from "../fs/mkdir.js";
import { resolveInode } from "../fs/resolve.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { writeFile, writeFileSync } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { computeManifestHash } from "./manifests.js";
import { currentRev, readWatermark, writeWatermark } from "./watermarks.js";

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
  // Where the entries came from. 'local' (default) treats the apply
  // path like any other mutation: writeFile/mkdir/etc bump vfs_meta.rev
  // and the push loop later ships those new revs upstream. 'upstream'
  // means the entries came from a remote push or fetch; the apply
  // still bumps rev (so readers see fresh data) but we advance pushRev
  // to match, so the push loop knows everything in this range is
  // already on the wire. Without this flag, applying an upstream
  // entry would generate a push-back on the next tick and the two
  // sides would ping-pong forever.
  source?: "local" | "upstream";
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
// from the underlying FS helpers — mkdir, writeFile, symlink,
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
  // Snapshot rev before we touch anything. Used by the loopback-
  // suppression at the bottom to decide whether it's safe to
  // advance pushRev past the entries this apply produced.
  const revBeforeApply = currentRev(db);
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES;
  const maxPaths = options.maxPathsPerBatch ?? DEFAULT_MAX_PATHS;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for await (const entry of entries) {
    // Idempotent skip: if the entry already matches the local
    // state, drop it on the floor. The check is what stops a
    // pull from bumping vfs_meta.rev for entries that are
    // already in place, which in turn stops the next push from
    // re-shipping them.
    if (options.source === "upstream" && entry.kind !== "delete") {
      if (alreadyApplied(db, entry)) continue;
    }
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Already gone is fine — idempotent apply.
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
    // file: assemble chunk bytes. First check the in-memory map
    // (the streaming hand-off); fall back to vfs_blob_bytes (the
    // staged-via-pushObjects path).
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const c of entry.chunks) {
      const k = hex(c.hash);
      let bytes = objects.get(k);
      if (bytes === undefined) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          c.hash,
        );
        bytes = row?.bytes;
      }
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

  // Loopback suppression: when this apply pass reflects entries
  // from upstream, the writeFile/mkdir/symlink/rm calls inside
  // bumped vfs_meta.rev. Without this advance, the next push tick
  // would see those rev bumps as fresh local changes and push them
  // back to upstream, which would apply them and bump again, and
  // so on.
  //
  // Subtle: we can only advance pushRev when it already covered
  // every rev that existed *before* this apply. If the caller had
  // unpushed local writes sitting between (existing, revBeforeApply],
  // advancing pushRev past them would strand them — the next
  // pushOnce would skip them as already-shipped. That was F1: a
  // pull whose entries were all idempotent-skipped still bumped
  // pushRev up to currentRev, masking local writes that hadn't
  // shipped yet.
  //
  // In the unsafe case we leave pushRev alone. The next pushOnce
  // drains both the unpushed locals and the apply's own bumps;
  // the receiver's alreadyApplied() check suppresses the latter.
  // One redundant round-trip per apply, bounded.
  if (options.source === "upstream") {
    const revAfter = currentRev(db);
    const existing = readWatermark(db, "pushRev");
    if (existing >= revBeforeApply && revAfter > existing) {
      writeWatermark(db, "pushRev", revAfter);
    }
  }
}

// Synchronous variant of applyChanges. Same semantics; takes an
// in-memory entry array instead of an iterable. Used on the push
// receiver so the whole batch can run inside a single transactionSync
// and a mid-stream failure rolls back every prior entry.
//
// Stays separate from applyChanges so the streaming pull path
// (which can't hold a sync transaction across network I/O) keeps
// its async semantics.
export function applyChangesSync(
  db: Database,
  entries: readonly ChangeEntry[],
  objects: Map<string, Uint8Array>,
  options: ApplyOptions = {},
): void {
  const revBeforeApply = currentRev(db);
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES;
  const maxPaths = options.maxPathsPerBatch ?? DEFAULT_MAX_PATHS;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for (const entry of entries) {
    if (options.source === "upstream" && entry.kind !== "delete") {
      if (alreadyApplied(db, entry)) continue;
    }
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Already gone is fine — idempotent apply.
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
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const c of entry.chunks) {
      const k = hex(c.hash);
      let bytes = objects.get(k);
      if (bytes === undefined) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          c.hash,
        );
        bytes = row?.bytes;
      }
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
    writeFileSync(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
  }

  if (options.advanceFetchRev !== undefined) {
    const current = readWatermark(db, "fetchRev");
    if (options.advanceFetchRev > current) {
      writeWatermark(db, "fetchRev", options.advanceFetchRev);
    }
  }

  if (options.source === "upstream") {
    const revAfter = currentRev(db);
    const existing = readWatermark(db, "pushRev");
    if (existing >= revBeforeApply && revAfter > existing) {
      writeWatermark(db, "pushRev", revAfter);
    }
  }
}

// Compare an entry against the local node graph. Returns true when
// the entry would be a no-op apply: the manifest hash (files),
// mode + symlink target (symlinks), or mode (dirs) already matches.
// We deliberately skip mtime comparison — mtime is metadata
// the source decides on, and re-applying it would still bump the
// local rev counter for nothing. Receivers see eventual mtime
// drift between peers; the wire stays quiet.
function alreadyApplied(db: Database, entry: Exclude<ChangeEntry, { kind: "delete" }>): boolean {
  const live = resolveInode(db, entry.path, { followSymlinks: false });
  if (live === null) return false;

  if (entry.kind === "file") {
    if (live.type !== "file") return false;
    const row = db.one<{ manifest_hash: Uint8Array | null }>(
      "SELECT manifest_hash FROM vfs_nodes WHERE inode = ?",
      live.inode,
    );
    if (!row?.manifest_hash) return false;
    const wanted = computeManifestHash(entry.chunks);
    return uint8Equal(row.manifest_hash, wanted);
  }
  if (entry.kind === "dir") {
    return live.type === "dir" && (live.mode & 0o7777) === (entry.mode & 0o7777);
  }
  // symlink
  return (
    live.type === "symlink" &&
    live.linkTarget === entry.target &&
    (live.mode & 0o7777) === (entry.mode & 0o7777)
  );
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
