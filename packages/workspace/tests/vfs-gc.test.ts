/**
 * mark-and-sweep GC for orphan manifests and blobs.
 *
 * Stages 1 and 2 deliberately leave orphan rows behind on every overwrite
 * or delete \u2014 the chunks/manifests of replaced or deleted files stay in
 * place so a partial-failure mid-write can never expose torn state and so
 * the bookkeeping has no refcount cliff to fall off. GC reclaims them.
 *
 * Design:
 *   - vfs_manifests: orphan iff no vfs_nodes row points at it.
 *   - vfs_blobs:     orphan iff no vfs_chunks row references it
 *                    AND last_seen is older than the safety window.
 *   - safety window prevents racing a still-uploading peer in stage 3
 *     (manifest-aware sync). With stage 3 not yet implemented the
 *     window is mostly defensive, but keeping it from day one means
 *     the protocol doesn't change later.
 *   - Idempotent: re-running GC immediately after a previous sweep
 *     reclaims nothing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/vfs.ts";
import { makeShimStorage } from "./sql-shim.ts";

const TEXT = (s: string) => new TextEncoder().encode(s);

function makeVfs() {
  const storage = makeShimStorage();
  const vfs = new Vfs(storage.sql as unknown as SqlStorage);
  return { vfs, storage };
}

function count(storage: ReturnType<typeof makeShimStorage>, table: string): number {
  const rows = [...storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)];
  return rows[0]?.n ?? 0;
}

describe("Vfs.gc \u2014 mark-and-sweep", () => {
  test("reclaims orphan manifests whose nodes were deleted", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("payload"));
    assert.equal(count(storage, "vfs_manifests"), 1);

    vfs.deleteFile("/workspace/a.txt");
    // Pre-GC: node row gone, manifest row lingers.
    assert.equal(count(storage, "vfs_manifests"), 1);

    // GC with a 0ms safety window so old blobs are also reachable.
    const out = vfs.gc(0);
    assert.equal(out.manifestsFreed, 1);
    assert.equal(count(storage, "vfs_manifests"), 0);
  });

  test("reclaims orphan blobs whose chunks were dropped, past the safety window", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("v1"));
    const blobsAfterWrite = count(storage, "vfs_blobs");
    assert.equal(blobsAfterWrite, 1);

    // Overwrite with different bytes \u2014 the v1 blob is orphaned, the v2
    // blob is referenced from vfs_chunks.
    vfs.writeFile("/workspace/a.txt", TEXT("v2"));
    assert.equal(count(storage, "vfs_blobs"), 2);

    const out = vfs.gc(0);
    assert.equal(out.blobsFreed, 1);
    assert.equal(count(storage, "vfs_blobs"), 1);
    // Reading the live file still works.
    assert.equal(new TextDecoder().decode(vfs.readFile("/workspace/a.txt")!), "v2");
  });

  test("safety window keeps fresh orphan blobs alive", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("v1"));
    vfs.writeFile("/workspace/a.txt", TEXT("v2"));
    // Both blobs have last_seen \u2248 now. With a generous safety window
    // the orphan from v1 stays put.
    const out = vfs.gc(10 * 60 * 1000);  // 10 minutes
    assert.equal(out.blobsFreed, 0);
    assert.equal(count(storage, "vfs_blobs"), 2);
  });

  test("two paths share a blob; deleting one leaves the blob alive", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("shared"));
    vfs.writeFile("/workspace/b.txt", TEXT("shared"));
    assert.equal(count(storage, "vfs_blobs"), 1);

    vfs.deleteFile("/workspace/a.txt");
    const out = vfs.gc(0);
    // Blob is still referenced by /workspace/b.txt's chunk row, so it survives.
    assert.equal(out.blobsFreed, 0);
    assert.equal(count(storage, "vfs_blobs"), 1);
    assert.equal(new TextDecoder().decode(vfs.readFile("/workspace/b.txt")!), "shared");
  });

  test("GC is idempotent: a second sweep right after the first frees nothing", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("v1"));
    vfs.writeFile("/workspace/a.txt", TEXT("v2"));
    vfs.gc(0);
    const second = vfs.gc(0);
    assert.equal(second.manifestsFreed, 0);
    assert.equal(second.blobsFreed,     0);
  });

  test("GC default safety window is non-zero (sane production default)", () => {
    // Pin down the default so a future change has to update this test
    // on purpose. The behavior under test: with the default, blobs
    // touched milliseconds ago are not reclaimed.
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/a.txt", TEXT("v1"));
    vfs.writeFile("/workspace/a.txt", TEXT("v2"));
    const out = vfs.gc();  // no argument: default window
    assert.equal(out.blobsFreed, 0,
      "default window must protect blobs whose last_seen is very recent");
    assert.equal(count(storage, "vfs_blobs"), 2);
  });

  test("GC after a subtree delete reclaims every orphan blob in the subtree", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/dir/a.txt", TEXT("a-bytes"));
    vfs.writeFile("/workspace/dir/b.txt", TEXT("b-bytes"));
    vfs.writeFile("/workspace/sibling.txt", TEXT("keep"));
    assert.equal(count(storage, "vfs_blobs"), 3);

    vfs.deleteFile("/workspace/dir");
    const out = vfs.gc(0);
    assert.equal(out.blobsFreed,     2);
    assert.equal(out.manifestsFreed, 2);
    assert.equal(count(storage, "vfs_blobs"), 1);
    assert.equal(new TextDecoder().decode(vfs.readFile("/workspace/sibling.txt")!), "keep");
  });
});
