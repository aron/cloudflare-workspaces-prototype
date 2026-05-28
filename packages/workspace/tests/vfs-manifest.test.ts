/**
 * manifests as a first-class object.
 *
 * vfs_manifests rows are canonical, content-addressed file layouts.
 * vfs_nodes.manifest_hash points at them for type='file' rows. The
 * manifest hash input is the chunk list only — path, mode, mtime,
 * mount_root, and stub_size all live on vfs_nodes, never on the
 * manifest. Otherwise identical bytes written one second apart at
 * different paths would produce different manifest hashes and dedup
 * would collapse.
 *
 * vfs_chunks remains authoritative content storage in this stage;
 * the manifest is a parallel index kept in sync on every mutation.
 * Stage 3 makes the manifest the wire-format unit; stage 4 GCs it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Vfs } from "../src/vfs.ts";
import { CHUNK_SIZE } from "../src/shared/index.ts";
import { makeShimStorage } from "./sql-shim.ts";

const TEXT = (s: string) => new TextEncoder().encode(s);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function makeVfs() {
  const storage = makeShimStorage();
  const vfs = new Vfs(storage.sql as unknown as SqlStorage);
  return { vfs, storage };
}

function count(storage: ReturnType<typeof makeShimStorage>, table: string): number {
  const rows = [...storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)];
  return rows[0]?.n ?? 0;
}

function manifestHashOf(
  storage: ReturnType<typeof makeShimStorage>,
  path: string,
): Uint8Array | null {
  const rows = [...storage.sql.exec<{ manifest_hash: Uint8Array | null }>(
    `SELECT manifest_hash FROM vfs_nodes WHERE path = ?`, path,
  )];
  const h = rows[0]?.manifest_hash;
  return h ? new Uint8Array(h) : null;
}

describe("Vfs manifest table (stage 2)", () => {
  test("writeFile populates vfs_nodes.manifest_hash and inserts a vfs_manifests row", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("hello"));

    const h = manifestHashOf(storage, "/workspace/a.txt");
    assert.ok(h, "manifest_hash must be set on the node row");
    assert.equal(h!.length, 32, "manifest hash is 32 bytes (sha256)");

    const manifests = [...storage.sql.exec<{ hash: Uint8Array; size: number }>(
      `SELECT hash, size FROM vfs_manifests`,
    )];
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].size, 5);
    assert.deepEqual(Buffer.from(manifests[0].hash), Buffer.from(h!));
  });

  test("identical bytes at two paths share one manifest row", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("identical bytes"));
    vfs.writeFile("/workspace/b.txt", TEXT("identical bytes"));

    assert.equal(count(storage, "vfs_manifests"), 1,
      "shared content must dedup at the manifest level too");
    assert.deepEqual(
      manifestHashOf(storage, "/workspace/a.txt"),
      manifestHashOf(storage, "/workspace/b.txt"),
    );
  });

  test("manifest hash is independent of path, mode, and mtime", () => {
    // The cardinal sin in stage 2 is folding node-level metadata into
    // the manifest hash input. If any of these factors change the
    // manifest hash, dedup falls over. This test pins it down.
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("payload"), 0o100644);
    // Force a measurable mtime gap so a buggy implementation that
    // includes mtime in the hash input fails loudly here.
    const before = Date.now();
    while (Date.now() === before) { /* spin one millisecond */ }
    vfs.writeFile("/workspace/deep/nested/b.bin", TEXT("payload"), 0o100755);

    const ha = manifestHashOf(storage, "/workspace/a.txt");
    const hb = manifestHashOf(storage, "/workspace/deep/nested/b.bin");
    assert.deepEqual(ha, hb,
      "manifest hash must depend on chunk content only, not on path/mode/mtime");
  });

  test("rewriting a file with identical bytes is a no-op at the manifest layer", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("same"));
    const first = manifestHashOf(storage, "/workspace/a.txt");
    vfs.writeFile("/workspace/a.txt", TEXT("same"));
    const second = manifestHashOf(storage, "/workspace/a.txt");

    assert.deepEqual(first, second);
    assert.equal(count(storage, "vfs_manifests"), 1);
  });

  test("overwriting with different bytes points the node at a new manifest", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("first"));
    const h1 = manifestHashOf(storage, "/workspace/a.txt");
    vfs.writeFile("/workspace/a.txt", TEXT("second"));
    const h2 = manifestHashOf(storage, "/workspace/a.txt");

    assert.notDeepEqual(h1, h2);
    // Old manifest row lingers until stage-4 GC.
    assert.equal(count(storage, "vfs_manifests"), 2);
  });

  test("writeChunks rebuilds the manifest from the current chunk set", () => {
    // writeChunks doesn't get the whole file's bytes — only the slots
    // that changed. The manifest still has to reflect the full ordered
    // chunk list afterwards, so the manifest rebuild has to read from
    // vfs_chunks.
    const { vfs, storage } = makeVfs();
    // Seed with a two-chunk file via writeFile so chunks 0 and 1 exist.
    const big = new Uint8Array(CHUNK_SIZE + 100);
    big.fill(0xAA, 0, CHUNK_SIZE);
    big.fill(0xBB, CHUNK_SIZE);
    vfs.writeFile("/workspace/big.bin", big);
    const before = manifestHashOf(storage, "/workspace/big.bin");

    // Rewrite chunk 0 with different bytes via writeChunks.
    const replacement = new Uint8Array(CHUNK_SIZE);
    replacement.fill(0xCC);
    vfs.writeChunks("/workspace/big.bin", [{ idx: 0, bytes: replacement }]);

    const after = manifestHashOf(storage, "/workspace/big.bin");
    assert.notDeepEqual(before, after,
      "writeChunks must update the node's manifest_hash to reflect the new chunk list");

    // The new manifest must reflect the actual full chunk sequence,
    // not just the slot that changed.
    const manifestRow = [...storage.sql.exec<{ size: number; encoded: Uint8Array }>(
      `SELECT size, encoded FROM vfs_manifests WHERE hash = ?`, after,
    )][0];
    assert.ok(manifestRow, "new manifest row exists");
    assert.equal(manifestRow.size, big.length,
      "manifest.size must equal the file's total byte length");
  });

  test("empty file has a stable, well-defined manifest", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/empty.txt", new Uint8Array(0));
    const h = manifestHashOf(storage, "/workspace/empty.txt");
    assert.ok(h, "empty files still get a manifest row");
    assert.equal(h!.length, 32);

    // A second empty file shares the same manifest hash.
    vfs.writeFile("/workspace/other-empty.txt", new Uint8Array(0));
    assert.deepEqual(manifestHashOf(storage, "/workspace/other-empty.txt"), h);
    assert.equal(count(storage, "vfs_manifests"), 1);
  });

  test("deleteFile clears manifest_hash on the node (manifest row lingers)", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("doomed"));
    assert.equal(count(storage, "vfs_manifests"), 1);

    vfs.deleteFile("/workspace/a.txt");
    // Node is gone outright, so manifest_hash is moot — but the manifest
    // row stays until stage-4 GC reclaims it.
    assert.equal(count(storage, "vfs_manifests"), 1,
      "manifest survives delete; stage-4 GC will reclaim it");
  });

  test("stubs have NULL manifest_hash", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeStub("/workspace/r2/big.bin", 0o100644, 1_700_000_000_000, "/workspace/r2", 4096);

    assert.equal(manifestHashOf(storage, "/workspace/r2/big.bin"), null,
      "an unhydrated stub has no manifest yet");
    assert.equal(count(storage, "vfs_manifests"), 0);
  });

  test("manifest encoding starts with a version byte and totals match", () => {
    // The encoding is opaque to callers, but pin enough of it down that
    // a future format change has to update this test on purpose.
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("hello world"));

    const row = [...storage.sql.exec<{ hash: Uint8Array; size: number; encoded: Uint8Array }>(
      `SELECT hash, size, encoded FROM vfs_manifests`,
    )][0];
    assert.equal(row.size, "hello world".length);
    const enc = new Uint8Array(row.encoded);
    assert.equal(enc[0], 0x01, "manifest encoding v1 starts with 0x01");
    // The encoding's hash matches the row's primary key.
    assert.deepEqual(Buffer.from(row.hash), sha256(enc));
  });
});

describe("Vfs manifest migration", () => {
  test("first boot on a stage-1 schema backfills manifests for existing files", () => {
    // Boot a stage-1 Vfs, write some files, then drop the manifest
    // bookkeeping the way an older deploy would have it: column missing,
    // table missing. Re-boot and check the backfill happened.
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("backfill me"));
    vfs.writeFile("/workspace/b.txt", TEXT("backfill me"));   // duplicate content
    vfs.writeFile("/workspace/c.txt", TEXT("different"));

    // Strip the stage-2 bookkeeping in place to simulate the pre-migration
    // state. We have to drop manifest_hash from vfs_nodes (sqlite supports
    // DROP COLUMN since 3.35) and drop the vfs_manifests table.
    storage.sql.exec(`DROP TABLE vfs_manifests`);
    storage.sql.exec(`ALTER TABLE vfs_nodes DROP COLUMN manifest_hash`);

    // Re-construct Vfs on the same storage — migrate() must add the
    // column, recreate the table, and walk every file to populate both.
    new Vfs(storage.sql as unknown as SqlStorage);

    assert.equal(count(storage, "vfs_manifests"), 2,
      "two distinct contents → two manifest rows after backfill");
    const ha = manifestHashOf(storage, "/workspace/a.txt");
    const hb = manifestHashOf(storage, "/workspace/b.txt");
    const hc = manifestHashOf(storage, "/workspace/c.txt");
    assert.ok(ha && hb && hc, "every file row got a manifest_hash");
    assert.deepEqual(ha, hb, "identical bytes share a manifest");
    assert.notDeepEqual(ha, hc);
  });
});
