/**
 * Worker-side virtual filesystem backed by Durable Object SQLite.
 *
 * Tables:
 *   vfs_seq    — monotonic counter, stamps every write for incremental sync
 *   vfs_nodes  — one row per path: metadata only (type, mode, mtime, seq)
 *   vfs_chunks — file content split into CHUNK_SIZE byte chunks (raw binary)
 *   vfs_changes — tombstones for deleted paths
 *
 * Files are chunked uniformly at 512 KB per chunk to stay under SQLITE_MAX_LENGTH.
 * Content is never base64-encoded — it travels as ReadableStream<Uint8Array>
 * over the capnweb wire and is stored as raw BLOB in SQLite.
 */

import type { VfsEntry, VfsChange } from "./shared/index.js";

const CHUNK_SIZE = 512 * 1024; // 512 KB

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

CREATE TABLE IF NOT EXISTS vfs_chunks (
  path    TEXT    NOT NULL,
  idx     INTEGER NOT NULL,
  data    BLOB    NOT NULL,
  PRIMARY KEY (path, idx)
);

CREATE TABLE IF NOT EXISTS vfs_changes (
  seq  INTEGER PRIMARY KEY,
  path TEXT    NOT NULL,
  op   TEXT    NOT NULL CHECK(op IN ('delete'))
);
`;

export class Vfs {
  // While true, mutating ops don't advance `seq` or record delete tombstones —
  // used by applyChanges() so remote-pushed rows don't echo back as new
  // outbound changes on the next getChangesSince().
  public applying = false;

  constructor(private sql: SqlStorage) {
    sql.exec(SCHEMA);
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
        `SELECT COALESCE(SUM(length(data)), 0) AS size FROM vfs_chunks WHERE path = ?`, path
      )];
      size = d[0]?.size ?? 0;
      // Unhydrated stub — use the size recorded by the mount's index pass.
      if (size === 0 && stub_size !== null) size = stub_size;
    }
    return { type: type as "file" | "dir", mode, mtime, size };
  }

  /** Read a file into a Uint8Array. */
  readFile(path: string): Uint8Array | null {
    const chunks = [...this.sql.exec<{ data: ArrayBuffer }>(
      `SELECT data FROM vfs_chunks WHERE path = ? ORDER BY idx`, path
    )];
    if (!chunks.length) return null;
    const parts = chunks.map(c => new Uint8Array(c.data));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  /** Read a file as a ReadableStream — used by the sync protocol. */
  readFileAsStream(path: string): ReadableStream<Uint8Array> {
    const chunks = [...this.sql.exec<{ data: ArrayBuffer }>(
      `SELECT data FROM vfs_chunks WHERE path = ? ORDER BY idx`, path
    )];
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c.data));
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
    const rows = this.sql.exec<{ idx: number; data: ArrayBuffer }>(
      `SELECT idx, data FROM vfs_chunks WHERE path = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
      path, firstIdx, lastIdx,
    );
    for (const row of rows) {
      const chunkStart = row.idx * CHUNK_SIZE;
      const buf = new Uint8Array(row.data);
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
      this.sql.exec(`INSERT INTO vfs_chunks(path, idx, data) VALUES (?, ?, ?)`, path, i, slice);
    }
  }

  async writeFileFromStream(path: string, stream: ReadableStream<Uint8Array>, mode = 0o100644): Promise<void> {
    const buf = await streamToUint8Array(stream);
    this.writeFile(path, buf, mode);
  }

  /**
   * Insert an unhydrated file stub: a `vfs_nodes` row with no `vfs_chunks`.
   * Used by the mount index pass — readdir/stat see the file, but reading
   * content triggers fetch on demand. The row is stamped with `mountRoot`
   * so writes can be rejected and the change-set push knows to hydrate first.
   */
  writeStub(path: string, mode: number, mtime: number, mountRoot: string, size: number | null = null): void {
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
    const seq = this.applying ? this.currentSeq() : this.nextSeq();
    this.ensureParentDirs(path);
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
    this.sql.exec(`DELETE FROM vfs_nodes WHERE path = ? OR (path >= ? AND path < ?)`,
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

  // ---- private helpers ----

  private nextSeq(): number {
    this.sql.exec(`UPDATE vfs_seq SET val = val + 1 WHERE id = 1`);
    return this.currentSeq();
  }

  private currentSeq(): number {
    return [...this.sql.exec<{ val: number }>(`SELECT val FROM vfs_seq WHERE id = 1`)][0]?.val ?? 0;
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      this.mkdir("/" + parts.slice(0, i).join("/"));
    }
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
