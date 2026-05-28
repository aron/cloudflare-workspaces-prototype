/**
 * Worker-side virtual filesystem backed by Durable Object SQLite.
 *
 * Tables:
 *   vfs_seq     — monotonic counter, stamps every write for incremental sync
 *   vfs_nodes   — one row per path: metadata only (type, mode, mtime, seq, mount_root, stub_size)
 *   vfs_blobs   — content-addressed chunk store keyed by sha256(bytes)
 *   vfs_chunks  — (path, idx) → vfs_blobs.hash mapping; one row per chunk slot
 *   vfs_changes — tombstones for deleted paths
 *
 * Files are chunked uniformly at CHUNK_SIZE per chunk (see shared/index.ts)
 * to stay under SQLITE_MAX_LENGTH. Content lives in vfs_blobs and is shared
 * across paths and versions whenever its sha256 collides — identical bytes
 * cost one row. Bytes travel over capnweb as ReadableStream<Uint8Array> and
 * are stored as raw BLOB in SQLite (no base64).
 */

import { createHash } from "node:crypto";
import { CHUNK_SIZE, type VfsEntry, type VfsChange } from "./shared/index.js";


const SCHEMA = `
CREATE TABLE IF NOT EXISTS vfs_seq (
  id  INTEGER PRIMARY KEY CHECK(id = 1),
  val INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO vfs_seq VALUES (1, 0);

CREATE TABLE IF NOT EXISTS vfs_nodes (
  path        TEXT    PRIMARY KEY,
  type        TEXT    NOT NULL CHECK(type IN ('file','dir')),
  mode        INTEGER NOT NULL DEFAULT 493,
  mtime       INTEGER NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  mount_root  TEXT,
  stub_size   INTEGER
);

CREATE TABLE IF NOT EXISTS vfs_blobs (
  hash      BLOB    PRIMARY KEY,        -- 32 bytes, sha256(bytes)
  size      INTEGER NOT NULL,            -- length(bytes), denormalized for SUM()
  bytes     BLOB    NOT NULL,
  last_seen INTEGER NOT NULL              -- ms since epoch; bumped on ref (stage 4 GC)
);

CREATE TABLE IF NOT EXISTS vfs_chunks (
  path TEXT    NOT NULL,
  idx  INTEGER NOT NULL,
  hash BLOB    NOT NULL,                  -- references vfs_blobs.hash
  size INTEGER NOT NULL,                  -- denormalized for fast stat() / SUM()
  PRIMARY KEY (path, idx)
);
-- The vfs_chunks_by_hash index is created inside migrate() so a legacy
-- vfs_chunks(path, idx, data) schema doesn't trip a "no such column: hash"
-- error on first boot before the rewrite runs.

CREATE TABLE IF NOT EXISTS vfs_manifests (
  hash    BLOB    PRIMARY KEY,            -- sha256(encoded)
  size    INTEGER NOT NULL,                -- total file size in bytes
  encoded BLOB    NOT NULL                 -- canonical encoding (v1: 0x01 || repeated (32-byte hash || varint offset || varint size))
);

CREATE TABLE IF NOT EXISTS vfs_changes (
  seq  INTEGER PRIMARY KEY,
  path TEXT    NOT NULL,
  op   TEXT    NOT NULL CHECK(op IN ('delete'))
);
`;

/**
 * Add columns that older deploys are missing. `CREATE TABLE IF NOT EXISTS`
 * only creates the table on first run — it doesn't reconcile schema drift
 * when columns are added later. We probe `PRAGMA table_info` and run
 * `ALTER TABLE ADD COLUMN` for anything missing.
 *
 * `ALTER TABLE ADD COLUMN` requires that the new column either be NULLable
 * or carry a constant default. Both of ours are NULLable, so this is safe
 * to re-run on every DO boot.
 */
function migrate(sql: SqlStorage): void {
  const nodeCols = new Set(
    [...sql.exec<{ name: string }>(`PRAGMA table_info(vfs_nodes)`)].map(r => r.name),
  );
  if (!nodeCols.has("mount_root")) sql.exec(`ALTER TABLE vfs_nodes ADD COLUMN mount_root TEXT`);
  if (!nodeCols.has("stub_size"))  sql.exec(`ALTER TABLE vfs_nodes ADD COLUMN stub_size INTEGER`);

  // : rewrite legacy vfs_chunks(path, idx, data) rows
  // into vfs_chunks(path, idx, hash, size) + vfs_blobs(hash, size, bytes,
  // last_seen). SCHEMA's CREATE TABLE IF NOT EXISTS is a no-op when the
  // legacy table already exists, so we detect the `data` column here and
  // do the rebuild in place. Idempotent: bails out cleanly once the v2
  // shape is in effect.
  const chunkCols = new Set(
    [...sql.exec<{ name: string }>(`PRAGMA table_info(vfs_chunks)`)].map(r => r.name),
  );
  if (chunkCols.has("data") && !chunkCols.has("hash")) {
    sql.exec(`CREATE TABLE vfs_chunks_v2 (
      path TEXT    NOT NULL,
      idx  INTEGER NOT NULL,
      hash BLOB    NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (path, idx)
    )`);
    const now = Date.now();
    const legacy = [...sql.exec<{ path: string; idx: number; data: ArrayBuffer }>(
      `SELECT path, idx, data FROM vfs_chunks`,
    )];
    for (const row of legacy) {
      const bytes = new Uint8Array(row.data);
      const hash = sha256(bytes);
      sql.exec(
        `INSERT OR IGNORE INTO vfs_blobs(hash, size, bytes, last_seen) VALUES (?, ?, ?, ?)`,
        hash, bytes.length, bytes, now,
      );
      sql.exec(
        `INSERT INTO vfs_chunks_v2(path, idx, hash, size) VALUES (?, ?, ?, ?)`,
        row.path, row.idx, hash, bytes.length,
      );
    }
    sql.exec(`DROP TABLE vfs_chunks`);
    sql.exec(`ALTER TABLE vfs_chunks_v2 RENAME TO vfs_chunks`);
  }
  // Always ensure the by-hash index exists, whether we just rebuilt the
  // table or booted onto an already-v2 schema.
  sql.exec(`CREATE INDEX IF NOT EXISTS vfs_chunks_by_hash ON vfs_chunks(hash)`);

  // : vfs_nodes.manifest_hash + vfs_manifests. The
  // CREATE TABLE in SCHEMA handled the table; older deploys are still
  // missing the column on vfs_nodes. Add it and backfill from the
  // existing vfs_chunks rows so every live file row carries a manifest.
  const nodeColsAfter = new Set(
    [...sql.exec<{ name: string }>(`PRAGMA table_info(vfs_nodes)`)].map(r => r.name),
  );
  if (!nodeColsAfter.has("manifest_hash")) {
    sql.exec(`ALTER TABLE vfs_nodes ADD COLUMN manifest_hash BLOB`);
    backfillManifests(sql);
  }
}

/**
 * Walk every file in vfs_nodes, compute its manifest from the current
 * vfs_chunks rows, and stamp the manifest_hash column. Used by the
 * stage-2 migration; idempotent because the manifest hash is
 * deterministic and INSERT OR IGNORE on vfs_manifests dedups.
 */
function backfillManifests(sql: SqlStorage): void {
  const files = [...sql.exec<{ path: string }>(
    `SELECT path FROM vfs_nodes WHERE type = 'file'`,
  )];
  for (const { path } of files) {
    putManifestForPath(sql, path);
  }
}

/**
 * sha256 of `bytes` as a Uint8Array. Stage 1 uses node:crypto's sync
 * createHash, which is available in workerd under `nodejs_compat`. The
 * synchronous shape matters: writeFile / writeChunks / applyChangesSync
 * are all sync, and the per-chunk hash has to live on the same call.
 */
function sha256(bytes: Uint8Array): Uint8Array {
  const h = createHash("sha256");
  h.update(bytes);
  return new Uint8Array(h.digest());
}

// ---- manifest helpers ----
//
// The manifest is the *content layout* of a file: an ordered list of
// (chunk hash, offset, size) tuples. Its hash input is the chunk list
// only — path, mode, mtime, mount_root, and stub_size all live on
// vfs_nodes. Folding any of those into the hash input would break
// dedup: identical bytes written one second apart at different paths
// would produce different manifest hashes.
//
// Canonical encoding v1:
//   [0x01]                              version tag, 1 byte
//   then for each chunk in idx order:
//     [32-byte hash]                    sha256(chunk bytes) — the vfs_blobs key
//     [varint offset]                   byte offset of chunk start in the file
//     [varint size]                     chunk byte length
//
// Varints are LEB128 unsigned: 7 data bits per byte, MSB = "more bytes follow".
// Empty files encode as just [0x01].

function encodeVarint(value: number, out: number[]): void {
  // Non-negative integers only; bytes upstream are bounded by CHUNK_SIZE
  // and file size limits in .
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
}

/**
 * Build the canonical encoding of a chunk list. `chunks` is the
 * vfs_chunks rows for one file, already ordered by `idx`. The encoding
 * is deterministic for any given chunk sequence, which is what makes
 * the manifest hash content-addressable.
 */
function encodeManifest(chunks: ReadonlyArray<{ hash: Uint8Array; size: number }>): Uint8Array {
  const out: number[] = [0x01];
  let offset = 0;
  for (const c of chunks) {
    if (c.hash.length !== 32) {
      throw new Error(`expected 32-byte chunk hash, got ${c.hash.length}`);
    }
    for (let i = 0; i < 32; i++) out.push(c.hash[i]);
    encodeVarint(offset, out);
    encodeVarint(c.size, out);
    offset += c.size;
  }
  return new Uint8Array(out);
}

/**
 * Recompute the manifest for `path` from the live vfs_chunks rows,
 * insert the manifest row if its hash is new, and stamp
 * vfs_nodes.manifest_hash. Safe to call on a path that has no chunks
 * (empty file): a stable "empty" manifest — just the version byte —
 * still gets recorded and the node points at it.
 */
function putManifestForPath(sql: SqlStorage, path: string): void {
  const chunks = [...sql.exec<{ hash: ArrayBuffer; size: number }>(
    `SELECT hash, size FROM vfs_chunks WHERE path = ? ORDER BY idx`, path,
  )].map(r => ({ hash: new Uint8Array(r.hash), size: r.size }));
  const encoded = encodeManifest(chunks);
  const manifestHash = sha256(encoded);
  const totalSize = chunks.reduce((n, c) => n + c.size, 0);
  sql.exec(
    `INSERT OR IGNORE INTO vfs_manifests(hash, size, encoded) VALUES (?, ?, ?)`,
    manifestHash, totalSize, encoded,
  );
  sql.exec(
    `UPDATE vfs_nodes SET manifest_hash = ? WHERE path = ?`,
    manifestHash, path,
  );
}

/**
 * Codes raised by Vfs invariant checks . Stable strings so
 * callers can branch on the kind of violation without string-matching.
 *
 *   FILE_AT_DIR_PATH — mkdir(p) but p already exists as a file.
 *   DIR_AT_FILE_PATH — writeFile / writeChunks / writeStub at p but p
 *                      already exists as a directory.
 *   PARENT_NOT_DIR   — a write at p but an ancestor of p is a file.
 *
 * Throw-by-default applies only to *direct* callers. When `vfs.applying`
 * is true, the remote change-log is authoritative: type mismatches are
 * treated as implicit type changes (file ↔ dir) instead of throws.
 */
export type VfsErrorCode =
  | "FILE_AT_DIR_PATH"
  | "DIR_AT_FILE_PATH"
  | "PARENT_NOT_DIR";

export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path: string;
  constructor(code: VfsErrorCode, path: string, message: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
    this.path = path;
  }
}

export class Vfs {
  // While true, mutating ops don't advance `seq` or record delete tombstones —
  // used by applyChanges() so remote-pushed rows don't echo back as new
  // outbound changes on the next getChangesSince().
  public applying = false;

  constructor(private sql: SqlStorage) {
    sql.exec(SCHEMA);
    migrate(sql);
  }

  // ---- reads ----

  stat(path: string): { type: "file" | "dir"; mode: number; mtime: number; size: number } | null {
    const rows = [...this.sql.exec<{ type: string; mode: number; mtime: number; stub_size: number | null }>(
      `SELECT type, mode, mtime, stub_size FROM vfs_nodes WHERE path = ?`, path
    )];
    if (!rows.length) return null;
    const { type, mode, mtime, stub_size } = rows[0];
    let size = 0;
    if (type === "file") {
      const d = [...this.sql.exec<{ size: number }>(
        `SELECT COALESCE(SUM(size), 0) AS size FROM vfs_chunks WHERE path = ?`, path
      )];
      size = d[0]?.size ?? 0;
      // Unhydrated stub — use the size recorded by the mount's index pass.
      if (size === 0 && stub_size !== null) size = stub_size;
    }
    return { type: type as "file" | "dir", mode, mtime, size };
  }

  /** Read a file into a Uint8Array. Joins vfs_chunks → vfs_blobs by hash. */
  readFile(path: string): Uint8Array | null {
    const chunks = [...this.sql.exec<{ bytes: ArrayBuffer }>(
      `SELECT b.bytes AS bytes
         FROM vfs_chunks c JOIN vfs_blobs b ON b.hash = c.hash
        WHERE c.path = ?
        ORDER BY c.idx`,
      path,
    )];
    if (!chunks.length) return null;
    const parts = chunks.map(c => new Uint8Array(c.bytes));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  /** Read a file as a ReadableStream — used by the sync protocol. */
  readFileAsStream(path: string): ReadableStream<Uint8Array> {
    const chunks = [...this.sql.exec<{ bytes: ArrayBuffer }>(
      `SELECT b.bytes AS bytes
         FROM vfs_chunks c JOIN vfs_blobs b ON b.hash = c.hash
        WHERE c.path = ?
        ORDER BY c.idx`,
      path,
    )];
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c.bytes));
        controller.close();
      },
    });
  }

  /**
   * Yield chunk-aligned slices that overlap [byteOffset, byteOffset+byteLength).
   * Reads only the SQLite rows whose `idx` range covers the request, so the
   * full file never lands in memory. Trims the first and last chunk to the
   * exact byte range.
   */
  *readChunks(path: string, byteOffset = 0, byteLength?: number): Iterable<Uint8Array> {
    const stat = this.stat(path);
    if (!stat || stat.type !== "file") throw new Error(`File not found: ${path}`);
    const end = byteLength === undefined ? stat.size : Math.min(stat.size, byteOffset + byteLength);
    if (end <= byteOffset) return;
    const firstIdx = Math.floor(byteOffset / CHUNK_SIZE);
    const lastIdx  = Math.floor((end - 1) / CHUNK_SIZE);
    const rows = this.sql.exec<{ idx: number; bytes: ArrayBuffer }>(
      `SELECT c.idx AS idx, b.bytes AS bytes
         FROM vfs_chunks c JOIN vfs_blobs b ON b.hash = c.hash
        WHERE c.path = ? AND c.idx BETWEEN ? AND ?
        ORDER BY c.idx`,
      path, firstIdx, lastIdx,
    );
    for (const row of rows) {
      const chunkStart = row.idx * CHUNK_SIZE;
      const buf = new Uint8Array(row.bytes);
      const sliceStart = Math.max(0, byteOffset - chunkStart);
      const sliceEnd   = Math.min(buf.length, end - chunkStart);
      if (sliceEnd > sliceStart) yield buf.subarray(sliceStart, sliceEnd);
    }
  }

  readdir(path: string): Array<{ name: string; type: "file" | "dir" }> {
    const prefix = path === "/" ? "/" : path + "/";
    const rows = [...this.sql.exec<{ path: string; type: string }>(
      `SELECT path, type FROM vfs_nodes WHERE path > ? AND path < ?`,
      path, rangeEnd(prefix),
    )];
    const results: Array<{ name: string; type: "file" | "dir" }> = [];
    for (const row of rows) {
      const rest = row.path.slice(prefix.length);
      if (!rest.includes("/")) {
        results.push({ name: rest, type: row.type as "file" | "dir" });
      }
    }
    return results;
  }

  /**
   * Cheap recursive enumeration of file paths under a prefix. Returns paths
   * only — no contents, no chunk reads. Pair with readFile() when you need
   * to materialize a subset.
   */
  listFilesUnder(prefix: string): string[] {
    const like = prefix.endsWith("/") ? prefix : prefix + "/";
    const rows = [...this.sql.exec<{ path: string }>(
      `SELECT path FROM vfs_nodes WHERE type = 'file' AND path >= ? AND path < ? ORDER BY path`,
      like, rangeEnd(like),
    )];
    return rows.map(r => r.path);
  }

  // ---- writes ----

  writeFile(path: string, content: Uint8Array, mode = 0o100644, mountRoot: string | null = null): void {
    this.assertWritableAsFile(path);
    const seq = this.applying ? this.currentSeq() : this.nextSeq();
    const mtime = Date.now();
    this.ensureParentDirs(path);
    this.sql.exec(
      `INSERT OR REPLACE INTO vfs_nodes(path, type, mode, mtime, seq, mount_root) VALUES (?, 'file', ?, ?, ?, ?)`,
      path, mode, mtime, seq, mountRoot
    );
    this.sql.exec(`DELETE FROM vfs_chunks WHERE path = ?`, path);
    const numChunks = Math.max(1, Math.ceil(content.length / CHUNK_SIZE));
    for (let i = 0; i < numChunks; i++) {
      const slice = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.putChunkRow(path, i, slice);
    }
    putManifestForPath(this.sql, path);
  }

  async writeFileFromStream(path: string, stream: ReadableStream<Uint8Array>, mode = 0o100644): Promise<void> {
    const buf = await streamToUint8Array(stream);
    this.writeFile(path, buf, mode);
  }

  /**
   * Apply a chunk-mode update: only the named chunks are written, the
   * unchanged chunks remain in place from a prior pull.  Used by the
   * chunk-sync apply path.
   *
   * The vfs_nodes row is upserted (mtime advances, seq advances unless
   * we're in applying-mode) so stat() reflects the change, but the
   * file's *size* is left unchanged: the caller doesn't know it, and
   * the chunk update isn't allowed to shrink the file behind the
   * caller's back.  A whole-file write or an explicit truncate (the
   * size-hint case in step 4) is the path for that.
   */
  writeChunks(
    path: string,
    chunks: ReadonlyArray<{ idx: number; bytes: Uint8Array }>,
    mode: number = 0o100644,
    mountRoot: string | null = null,
  ): void {
    this.assertWritableAsFile(path);
    const seq = this.applying ? this.currentSeq() : this.nextSeq();
    const mtime = Date.now();
    this.ensureParentDirs(path);
    // Upsert the metadata row.  We don't know the file's total size
    // here — trust the caller to ship size-changing updates via
    // writeFile() or an explicit truncate hint.
    this.sql.exec(
      `INSERT INTO vfs_nodes(path, type, mode, mtime, seq, mount_root) VALUES (?, 'file', ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET mode=excluded.mode, mtime=excluded.mtime, seq=excluded.seq`,
      path, mode, mtime, seq, mountRoot,
    );
    for (const { idx, bytes } of chunks) {
      this.putChunkRow(path, idx, bytes);
    }
    putManifestForPath(this.sql, path);
  }

  /**
   * Insert an unhydrated file stub: a `vfs_nodes` row with no `vfs_chunks`.
   * Used by the mount index pass — readdir/stat see the file, but reading
   * content triggers fetch on demand. The row is stamped with `mountRoot`
   * so writes can be rejected and the change-set push knows to hydrate first.
   */
  writeStub(path: string, mode: number, mtime: number, mountRoot: string, size: number | null = null): void {
    this.assertWritableAsFile(path);
    const seq = this.nextSeq();
    this.ensureParentDirs(path);
    this.sql.exec(
      `INSERT OR REPLACE INTO vfs_nodes(path, type, mode, mtime, seq, mount_root, stub_size) VALUES (?, 'file', ?, ?, ?, ?, ?)`,
      path, mode, mtime, seq, mountRoot, size,
    );
    this.sql.exec(`DELETE FROM vfs_chunks WHERE path = ?`, path);
  }

  mkdir(path: string, mode = 0o40755, mountRoot: string | null = null): void {
    if (path === "/") return;
    this.assertWritableAsDir(path);
    const seq = this.applying ? this.currentSeq() : this.nextSeq();
    this.ensureParentDirs(path);
    // INSERT OR IGNORE: if a directory row already exists at `path`,
    // mkdir is a no-op (idempotent). A file row at `path` is the case
    // assertWritableAsDir() handles — it either throws (direct caller)
    // or replaces (applying = true).
    this.sql.exec(
      `INSERT OR IGNORE INTO vfs_nodes(path, type, mode, mtime, seq, mount_root) VALUES (?, 'dir', ?, ?, ?, ?)`,
      path, mode, Date.now(), seq, mountRoot,
    );
  }

  /** Read the mount_root column for a path. null = regular file/dir. */
  getMountRoot(path: string): string | null {
    const rows = [...this.sql.exec<{ mount_root: string | null }>(
      `SELECT mount_root FROM vfs_nodes WHERE path = ?`, path,
    )];
    return rows[0]?.mount_root ?? null;
  }

  /** True if `path` is a file stub (mount-managed, no chunks yet). */
  isStub(path: string): boolean {
    const rows = [...this.sql.exec<{ c: number }>(
      `SELECT (SELECT COUNT(*) FROM vfs_chunks WHERE path = vfs_nodes.path) AS c
         FROM vfs_nodes WHERE path = ? AND type = 'file' AND mount_root IS NOT NULL`,
      path,
    )];
    return rows.length > 0 && rows[0].c === 0;
  }

  /** List all current stubs (mount file rows with zero chunks). */
  listStubs(): Array<{ path: string; mountRoot: string }> {
    return [...this.sql.exec<{ path: string; mount_root: string }>(
      `SELECT n.path AS path, n.mount_root AS mount_root
         FROM vfs_nodes n
        WHERE n.type = 'file'
          AND n.mount_root IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM vfs_chunks c WHERE c.path = n.path)`,
    )].map(r => ({ path: r.path, mountRoot: r.mount_root }));
  }

  deleteFile(path: string): void {
    const subtree = path + "/";
    // Drop the node rows.
    this.sql.exec(`DELETE FROM vfs_nodes WHERE path = ? OR (path >= ? AND path < ?)`,
      path, subtree, rangeEnd(subtree));
    // Drop their chunk content too — otherwise readFile() of a deleted
    // path would still return the orphaned chunks.
    this.sql.exec(`DELETE FROM vfs_chunks WHERE path = ? OR (path >= ? AND path < ?)`,
      path, subtree, rangeEnd(subtree));
    if (!this.applying) {
      const seq = this.nextSeq();
      this.sql.exec(`INSERT OR REPLACE INTO vfs_changes(seq, path, op) VALUES (?, ?, 'delete')`,
        seq, path);
    }
  }

  // ---- sync helpers ----

  snapshot(): { entries: VfsEntry[]; seq: number } {
    const seq = this.currentSeq();
    const nodes = [...this.sql.exec<{ path: string; type: string; mode: number; mtime: number }>(
      `SELECT path, type, mode, mtime FROM vfs_nodes ORDER BY path`
    )];
    const entries: VfsEntry[] = nodes.map(n => {
      const entry: VfsEntry = { path: n.path, type: n.type as "file" | "dir", mode: n.mode, mtime: n.mtime };
      if (n.type === "file") entry.content = this.readFileAsStream(n.path);
      return entry;
    });
    return { entries, seq };
  }

  getChangesSince(seq: number): VfsChange[] {
    const nodes = [...this.sql.exec<{ path: string; type: string; mode: number; mtime: number; seq: number }>(
      `SELECT path, type, mode, mtime, seq FROM vfs_nodes WHERE seq > ? ORDER BY seq`, seq
    )];
    const changes: VfsChange[] = nodes.map(n => {
      const c: VfsChange = { seq: n.seq, path: n.path, op: "upsert",
        type: n.type as "file" | "dir", mode: n.mode, mtime: n.mtime };
      if (n.type === "file") c.content = this.readFileAsStream(n.path);
      return c;
    });
    const deletes = [...this.sql.exec<{ seq: number; path: string }>(
      `SELECT seq, path FROM vfs_changes WHERE op = 'delete' AND seq > ? ORDER BY seq`, seq
    )];
    for (const d of deletes) changes.push({ seq: d.seq, path: d.path, op: "delete" });
    return changes.sort((a, b) => a.seq - b.seq);
  }

  async applyChanges(changes: VfsChange[]): Promise<{ seq: number }> {
    this.applying = true;
    try {
      for (const c of changes) {
        if (c.op === "delete") {
          this.deleteFile(c.path);
        } else if (c.type === "dir") {
          this.mkdir(c.path, c.mode);
        } else {
          if (c.content) {
            await this.writeFileFromStream(c.path, c.content, c.mode);
          } else {
            this.writeFile(c.path, new Uint8Array(0), c.mode);
          }
        }
      }
    } finally {
      this.applying = false;
    }
    return { seq: this.currentSeq() };
  }

  /**
   * Sync sibling of applyChanges() for callers that already hold every
   * file's bytes in memory (the bulk-pull path).  Drops the per-file
   * await on the stream reader, which lets the caller wrap the whole
   * loop in DurableObjectStorage.transactionSync for a single SQLite
   * commit instead of one transaction per row.
   */
  applyChangesSync(changes: ReadonlyArray<{
    path:   string;
    op:     "upsert" | "delete";
    type?:  "file" | "dir";
    mode?:  number;
    bytes?: Uint8Array;
    chunks?: ReadonlyArray<{ idx: number; bytes: Uint8Array }>;
  }>): { seq: number } {
    this.applying = true;
    try {
      for (const c of changes) {
        if (c.op === "delete") {
          this.deleteFile(c.path);
        } else if (c.type === "dir") {
          this.mkdir(c.path, c.mode);
        } else if (c.chunks) {
          // Chunk-mode upsert: rewrite only the named chunk rows.
          // Existing chunks for the path that aren't in `chunks` are
          // left in place — they're the unchanged bytes the DO already
          // has from a previous pull.
          this.writeChunks(c.path, c.chunks, c.mode);
        } else {
          this.writeFile(c.path, c.bytes ?? new Uint8Array(0), c.mode);
        }
      }
    } finally {
      this.applying = false;
    }
    return { seq: this.currentSeq() };
  }

  // ---- garbage collection ----

  /**
   * Default safety window for blob reclaim. Five minutes is a
   * conservative starting point: it protects chunks that arrive on
   * the wire just ahead of their manifest (the stage-3 sync ordering)
   * without leaking unbounded storage. Callers can pass a tighter
   * window for tests or aggressive reclaim policies.
   */
  static readonly GC_DEFAULT_WINDOW_MS = 5 * 60 * 1000;

  /**
   * Mark-and-sweep reclaim of orphan manifests and orphan blobs.
   *
   * 1. Drop every `vfs_manifests` row not referenced by any `vfs_nodes.manifest_hash`.
   * 2. Drop every `vfs_blobs` row not referenced by any `vfs_chunks.hash`,
   *    provided its `last_seen` falls before `now - safetyWindowMs`.
   *
   * Refcount-free by design — the audit (v3) calls out
   * inline refcounts as fragile under DO async gaps; mark-and-sweep
   * is recoverable from any partial-failure state.
   *
   * Returns counts so callers (and tests) can verify what was reclaimed.
   */
  gc(safetyWindowMs: number = Vfs.GC_DEFAULT_WINDOW_MS): { manifestsFreed: number; blobsFreed: number } {
    // Manifests: no `last_seen` column — they're cheap to recompute,
    // so we don't keep a window for them. Anything not referenced by
    // a live node row is fair game.
    const orphanManifests = [...this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vfs_manifests
        WHERE hash NOT IN (SELECT manifest_hash FROM vfs_nodes WHERE manifest_hash IS NOT NULL)`,
    )][0]?.n ?? 0;
    this.sql.exec(
      `DELETE FROM vfs_manifests
        WHERE hash NOT IN (SELECT manifest_hash FROM vfs_nodes WHERE manifest_hash IS NOT NULL)`,
    );

    // Blobs: safety window matters. Fresh blobs may belong to an
    // upload that hasn't installed its manifest yet (stage 3 will
    // make this concrete). Compare against last_seen, which is bumped
    // on every chunk-row write.
    const cutoff = Date.now() - safetyWindowMs;
    const orphanBlobs = [...this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vfs_blobs
        WHERE hash NOT IN (SELECT hash FROM vfs_chunks)
          AND last_seen <= ?`,
      cutoff,
    )][0]?.n ?? 0;
    this.sql.exec(
      `DELETE FROM vfs_blobs
        WHERE hash NOT IN (SELECT hash FROM vfs_chunks)
          AND last_seen <= ?`,
      cutoff,
    );

    return { manifestsFreed: orphanManifests, blobsFreed: orphanBlobs };
  }

  // ---- private helpers ----

  /**
   * Write one chunk row, inserting the blob row first if its hash is new.
   * Centralises the content-addressed write path so writeFile / writeChunks
   * (and any future incremental chunker) cannot drift.
   *
   * Bumps the blob's `last_seen` on every reference so stage-4 GC's safety
   * window measures "unreferenced since" rather than "never touched."
   */
  private putChunkRow(path: string, idx: number, bytes: Uint8Array): void {
    const hash = sha256(bytes);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO vfs_blobs(hash, size, bytes, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen`,
      hash, bytes.length, bytes, now,
    );
    this.sql.exec(
      `INSERT INTO vfs_chunks(path, idx, hash, size) VALUES (?, ?, ?, ?)
         ON CONFLICT(path, idx) DO UPDATE SET hash = excluded.hash, size = excluded.size`,
      path, idx, hash, bytes.length,
    );
  }

  private nextSeq(): number {
    this.sql.exec(`UPDATE vfs_seq SET val = val + 1 WHERE id = 1`);
    return this.currentSeq();
  }

  private currentSeq(): number {
    return [...this.sql.exec<{ val: number }>(`SELECT val FROM vfs_seq WHERE id = 1`)][0]?.val ?? 0;
  }

  /**
   * Walk every ancestor of `path` and create it as a directory if missing.
   * If an ancestor already exists as a *file*, that's a structural error:
   *   - direct callers get PARENT_NOT_DIR
   *   - applying remote changes coerces the file to a dir (file rows
   *     and their chunks are removed first)
   */
  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const ancestor = "/" + parts.slice(0, i).join("/");
      const t = this.nodeTypeAt(ancestor);
      if (t === "file") {
        if (!this.applying) {
          throw new VfsError("PARENT_NOT_DIR", ancestor,
            `ancestor is a file, not a directory: ${ancestor}`);
        }
        // Apply path: drop the file row + chunks and let mkdir below
        // replace it with a dir. deleteFile clears chunks for path and
        // its (nonexistent) subtree.
        this.sql.exec(`DELETE FROM vfs_chunks WHERE path = ?`, ancestor);
        this.sql.exec(`DELETE FROM vfs_nodes  WHERE path = ?`, ancestor);
      }
      // Either missing or already a dir — mkdir() is idempotent for
      // existing dirs and creates the row if missing. Recursion through
      // mkdir's own ensureParentDirs handles deeper ancestors.
      this.mkdir(ancestor);
    }
  }

  /** 'file', 'dir', or null if no node exists at `path`. */
  private nodeTypeAt(path: string): "file" | "dir" | null {
    const rows = [...this.sql.exec<{ type: string }>(
      `SELECT type FROM vfs_nodes WHERE path = ?`, path,
    )];
    if (!rows.length) return null;
    return rows[0].type === "dir" ? "dir" : "file";
  }

  /**
   * Reject the write if `path` exists as a directory. In applying mode
   * the dir (and its subtree) is removed first so the file row can
   * land. Direct callers must handle the throw — we never silently
   * replace a directory with a file.
   */
  private assertWritableAsFile(path: string): void {
    const t = this.nodeTypeAt(path);
    if (t !== "dir") return;
    if (!this.applying) {
      throw new VfsError("DIR_AT_FILE_PATH", path,
        `cannot write file at directory path: ${path}`);
    }
    // Apply path: drop the existing dir and its entire subtree.
    this.deleteFile(path);
  }

  /**
   * Reject the mkdir if `path` exists as a file. In applying mode the
   * file (chunks + row) is removed first so the dir row can land.
   */
  private assertWritableAsDir(path: string): void {
    const t = this.nodeTypeAt(path);
    if (t !== "file") return;
    if (!this.applying) {
      throw new VfsError("FILE_AT_DIR_PATH", path,
        `cannot mkdir over existing file: ${path}`);
    }
    this.sql.exec(`DELETE FROM vfs_chunks WHERE path = ?`, path);
    this.sql.exec(`DELETE FROM vfs_nodes  WHERE path = ?`, path);
  }
}

// ---- stream helpers ----

/**
 * Upper bound for a `path >= prefix AND path < rangeEnd(prefix)` range scan.
 * Increments the last code unit; the empty string fallback yields the highest
 * possible path (\uFFFF), which means "any".
 *
 * Avoids SQLite's SQLITE_LIMIT_LIKE_PATTERN_LENGTH cap (~50 in workerd) that
 * `LIKE prefix%` runs into once /workspace contains a deeply-nested tree.
 */
function rangeEnd(prefix: string): string {
  if (prefix.length === 0) return "\uFFFF";
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export function uint8ArrayToStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}
