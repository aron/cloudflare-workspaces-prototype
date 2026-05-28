/**
 * content-addressed chunk storage behind the
 * existing `(path, idx)` API.
 *
 * Stage 1 promises:
 *   - File content is stored as SHA-256-keyed `vfs_blobs` rows.
 *   - Identical bytes across paths share one blob row.
 *   - Identical-bytes overwrites do not create a new blob row.
 *   - Different-bytes overwrites leave the old blob row in place
 *     (reclamation lands in stage 4 — mark-and-sweep GC).
 *   - The migration upgrades an existing `vfs_chunks(path, idx, data)`
 *     schema in place: every chunk's bytes are hashed, blobs are
 *     inserted, and `vfs_chunks` is rewritten to the v2 shape.
 *   - Stubs (mount-managed rows with zero chunks) continue to behave.
 *
 * The public API is unchanged: writeFile / readFile / readChunks /
 * writeChunks / writeStub / deleteFile / stat all keep their signatures.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { Vfs } from "../src/vfs.ts";
import { makeShimStorage } from "./sql-shim.ts";

const TEXT = (s: string) => new TextEncoder().encode(s);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function makeVfs() {
  const storage = makeShimStorage();
  const vfs = new Vfs(storage.sql as unknown as SqlStorage);
  return { vfs, storage };
}

/** Count rows in a table — handy for "did we dedup?" assertions. */
function count(storage: ReturnType<typeof makeShimStorage>, table: string): number {
  const rows = [...storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)];
  return rows[0]?.n ?? 0;
}

describe("Vfs content-addressed storage (stage 1)", () => {
  test("writeFile stores bytes in vfs_blobs keyed by sha256", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("hello"));

    const blobs = [...storage.sql.exec<{ hash: Uint8Array; size: number }>(
      `SELECT hash, size FROM vfs_blobs`,
    )];
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].size, 5);
    assert.deepEqual(Buffer.from(blobs[0].hash), sha256(TEXT("hello")));
  });

  test("identical bytes at two different paths share one blob row", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("shared bytes"));
    vfs.writeFile("/workspace/b.txt", TEXT("shared bytes"));

    assert.equal(count(storage, "vfs_blobs"), 1, "shared content must dedup");
    assert.equal(count(storage, "vfs_chunks"), 2,
      "each path still owns its own chunk row");
  });

  test("rewriting a file with identical bytes does not create a new blob row", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("same"));
    vfs.writeFile("/workspace/a.txt", TEXT("same"));

    assert.equal(count(storage, "vfs_blobs"), 1);
    assert.equal(count(storage, "vfs_chunks"), 1);
  });

  test("overwriting with different bytes keeps the old blob (GC reclaims later)", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("first"));
    vfs.writeFile("/workspace/a.txt", TEXT("second"));

    // Two blob rows; the old one is unreferenced until stage-4 GC.
    assert.equal(count(storage, "vfs_blobs"), 2);
    assert.equal(count(storage, "vfs_chunks"), 1);
    assert.equal(new TextDecoder().decode(vfs.readFile("/workspace/a.txt")!), "second");
  });

  test("writeChunks dedups against existing blob rows", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("AAA"));
    // Rewriting chunk 0 of a different path with the same bytes
    // must reuse the existing blob row.
    vfs.writeChunks("/workspace/b.txt", [{ idx: 0, bytes: TEXT("AAA") }]);

    assert.equal(count(storage, "vfs_blobs"), 1);
    assert.equal(count(storage, "vfs_chunks"), 2);
  });

  test("applyChangesSync chunk-mode upserts share blobs with prior whole-file writes", () => {
    // The bulk-pull apply path lands here. A chunk-mode upsert that ships
    // the same bytes a previous whole-file write already stored must not
    // create a second vfs_blobs row — that's the whole dedup pitch on the
    // wire-adjacent path.
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("shared"));
    vfs.applyChangesSync([
      {
        path: "/workspace/b.txt",
        op:   "upsert",
        type: "file",
        chunks: [{ idx: 0, bytes: TEXT("shared") }],
      },
    ]);
    assert.equal(count(storage, "vfs_blobs"), 1);
    assert.equal(count(storage, "vfs_chunks"), 2);
  });

  test("readFile returns the original bytes through the blob join", () => {
    const { vfs } = makeVfs();
    const payload = TEXT("round-trip me");
    vfs.writeFile("/workspace/a.txt", payload);
    assert.deepEqual(vfs.readFile("/workspace/a.txt"), payload);
  });

  test("readFile returns null for a path with no node", () => {
    const { vfs } = makeVfs();
    assert.equal(vfs.readFile("/workspace/missing.txt"), null);
  });

  test("deleteFile drops chunk rows but leaves blobs (stage-4 GC)", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("bytes"));
    vfs.deleteFile("/workspace/a.txt");

    assert.equal(count(storage, "vfs_chunks"), 0);
    assert.equal(count(storage, "vfs_blobs"), 1,
      "blob is orphaned but kept until GC");
    assert.equal(vfs.readFile("/workspace/a.txt"), null);
  });

  test("stat returns the file size summed from chunk.size", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("twelve bytes"));
    const s = vfs.stat("/workspace/a.txt");
    assert.equal(s?.size, "twelve bytes".length);
  });

  test("stubs still report mount-recorded size and remain unreadable", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeStub("/workspace/r2/big.bin", 0o100644, 1_700_000_000_000, "/workspace/r2", 4096);

    assert.equal(vfs.isStub("/workspace/r2/big.bin"), true);
    assert.equal(vfs.stat("/workspace/r2/big.bin")?.size, 4096);
    assert.equal(vfs.readFile("/workspace/r2/big.bin"), null);
    assert.equal(count(storage, "vfs_chunks"), 0);
    assert.equal(count(storage, "vfs_blobs"), 0);
  });
});

describe("Vfs schema migration from legacy vfs_chunks(path, idx, data)", () => {
  test("legacy chunk rows are rewritten to (hash, size) + vfs_blobs on first boot", () => {
    // Build a database with the legacy schema and one file's worth of
    // chunks, then construct a Vfs on top — its constructor must
    // migrate transparently.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE vfs_seq (id INTEGER PRIMARY KEY CHECK(id = 1), val INTEGER NOT NULL DEFAULT 0);
      INSERT INTO vfs_seq VALUES (1, 1);
      CREATE TABLE vfs_nodes (
        path        TEXT    PRIMARY KEY,
        type        TEXT    NOT NULL,
        mode        INTEGER NOT NULL DEFAULT 493,
        mtime       INTEGER NOT NULL,
        seq         INTEGER NOT NULL DEFAULT 0,
        mount_root  TEXT,
        stub_size   INTEGER
      );
      CREATE TABLE vfs_chunks (
        path    TEXT    NOT NULL,
        idx     INTEGER NOT NULL,
        data    BLOB    NOT NULL,
        PRIMARY KEY (path, idx)
      );
      CREATE TABLE vfs_changes (
        seq  INTEGER PRIMARY KEY,
        path TEXT    NOT NULL,
        op   TEXT    NOT NULL
      );
    `);
    db.prepare(`INSERT INTO vfs_nodes(path, type, mode, mtime, seq) VALUES (?, 'file', 420, 1, 1)`)
      .run("/workspace/a.txt");
    db.prepare(`INSERT INTO vfs_chunks(path, idx, data) VALUES (?, 0, ?)`)
      .run("/workspace/a.txt", TEXT("legacy bytes"));

    // Wrap the database in a sql-shim style adapter and hand it to Vfs.
    const shim = {
      sql: {
        exec<T = Record<string, unknown>>(sqlText: string, ...bindings: unknown[]): Iterable<T> {
          const binds = bindings.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v) as never[];
          if (bindings.length === 0 && /;\s*\S/.test(sqlText)) {
            db.exec(sqlText);
            return [];
          }
          const stmt = db.prepare(sqlText);
          if (/^\s*select\b|^\s*pragma\b|^\s*with\b/i.test(sqlText)) {
            return stmt.all(...binds) as T[];
          }
          stmt.run(...binds);
          return [];
        },
      },
    };
    const vfs = new Vfs(shim.sql as unknown as SqlStorage);

    // Migration happened: blob row exists, chunk row points at it by hash,
    // and reads still round-trip.
    const blobs = [...shim.sql.exec<{ hash: Uint8Array; size: number }>(
      `SELECT hash, size FROM vfs_blobs`,
    )];
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].size, "legacy bytes".length);
    assert.deepEqual(Buffer.from(blobs[0].hash), sha256(TEXT("legacy bytes")));

    const chunks = [...shim.sql.exec<{ path: string; idx: number; size: number }>(
      `SELECT path, idx, size FROM vfs_chunks`,
    )];
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].path, "/workspace/a.txt");
    assert.equal(chunks[0].idx, 0);
    assert.equal(chunks[0].size, "legacy bytes".length);

    assert.deepEqual(vfs.readFile("/workspace/a.txt"), TEXT("legacy bytes"));
  });

  test("migration is idempotent — booting twice is a no-op the second time", () => {
    const { storage } = makeVfs();
    new Vfs(storage.sql as unknown as SqlStorage);
    new Vfs(storage.sql as unknown as SqlStorage);
    // Re-booting on a v2 schema must not blow up. No assertions beyond
    // "constructor returned cleanly."
  });
});
