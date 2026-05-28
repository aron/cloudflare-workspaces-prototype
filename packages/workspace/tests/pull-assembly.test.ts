/**
 * , piece 3: DO-side pull assembly.
 *
 * The DO needs to (a) work out which chunk hashes it lacks in its own
 * vfs_blobs, (b) ask the container for only those bytes, then (c)
 * assemble each file from a union of fetched bytes and already-local
 * blobs. These helpers are the pure core of that flow; Workspace.exec
 * is a thin wrapper around them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { chunkHashUnion, assembleFileBytes, assembleAllFiles, hashKey } from "../src/pull-assembly.ts";
import type { ManifestBulk } from "../src/shared/index.ts";

const BUF = (len: number, fill: number) => Buffer.alloc(len, fill);
const sha256 = (b: Buffer) => new Uint8Array(createHash("sha256").update(b).digest());

describe("chunkHashUnion", () => {
  test("returns one entry per distinct chunk hash across all file changes", () => {
    const h1 = sha256(BUF(10, 0xaa));
    const h2 = sha256(BUF(10, 0xbb));
    const bulk: ManifestBulk = {
      maxRev: 5,
      changes: [
        { seq: 0, path: "/workspace/a", op: "upsert", type: "file", mode: 0o100644, mtime: 1,
          chunks: [{ hash: h1, size: 10 }, { hash: h2, size: 10 }] },
        // Second file shares h1 \u2014 must dedup to one entry.
        { seq: 1, path: "/workspace/b", op: "upsert", type: "file", mode: 0o100644, mtime: 1,
          chunks: [{ hash: h1, size: 10 }] },
      ],
    };
    const out = chunkHashUnion(bulk);
    assert.equal(out.length, 2);
    const keys = new Set(out.map(hashKey));
    assert.ok(keys.has(hashKey(h1)));
    assert.ok(keys.has(hashKey(h2)));
  });

  test("skips deletes and dirs", () => {
    const bulk: ManifestBulk = {
      maxRev: 1,
      changes: [
        { seq: 0, path: "/workspace/d",   op: "upsert", type: "dir",  mode: 0o40755, mtime: 1 },
        { seq: 1, path: "/workspace/old", op: "delete" },
      ],
    };
    assert.deepEqual(chunkHashUnion(bulk), []);
  });
});

describe("assembleFileBytes", () => {
  test("concatenates chunk bytes in order using the lookup", () => {
    const a = BUF(5, 0xaa);  const ha = sha256(a);
    const b = BUF(3, 0xbb);  const hb = sha256(b);
    const lookup = (h: Uint8Array) =>
      hashKey(h) === hashKey(ha) ? new Uint8Array(a) :
      hashKey(h) === hashKey(hb) ? new Uint8Array(b) : null;
    const out = assembleFileBytes([{ hash: ha, size: 5 }, { hash: hb, size: 3 }], lookup);
    assert.equal(out.length, 8);
    assert.deepEqual(out.subarray(0, 5), new Uint8Array(a));
    assert.deepEqual(out.subarray(5),    new Uint8Array(b));
  });

  test("throws when a chunk hash isn't in the lookup", () => {
    const h = sha256(BUF(1, 0));
    assert.throws(() => assembleFileBytes([{ hash: h, size: 1 }], () => null),
      /missing bytes for hash/);
  });

  test("throws when the lookup returns a wrong-sized blob", () => {
    const h = sha256(BUF(4, 0xff));
    const lookup = () => new Uint8Array(2);  // size mismatch
    assert.throws(() => assembleFileBytes([{ hash: h, size: 4 }], lookup),
      /reports size 4 but bytes are 2/);
  });
});

describe("assembleAllFiles", () => {
  test("dedup scenario: two paths with identical content share a single chunk fetch", () => {
    // Models the headline stage-3 win: same content at two paths
    // appears twice in the manifest but the assembled bytes both come
    // from the same single lookup call. We don't enforce \"one lookup\"
    // here (caller-side optimization); we do verify both files come out
    // identical.
    const payload = BUF(20, 0x77);
    const h = sha256(payload);
    const bulk: ManifestBulk = {
      maxRev: 2,
      changes: [
        { seq: 0, path: "/workspace/a", op: "upsert", type: "file", mode: 0o100644, mtime: 1,
          chunks: [{ hash: h, size: 20 }] },
        { seq: 1, path: "/workspace/b", op: "upsert", type: "file", mode: 0o100644, mtime: 1,
          chunks: [{ hash: h, size: 20 }] },
      ],
    };
    let calls = 0;
    const lookup = (_h: Uint8Array) => { calls++; return new Uint8Array(payload); };
    const out = assembleAllFiles(bulk, lookup);
    assert.equal(out.size, 2);
    assert.deepEqual(out.get("/workspace/a"), new Uint8Array(payload));
    assert.deepEqual(out.get("/workspace/b"), new Uint8Array(payload));
    // chunkHashUnion would have returned 1 entry; a real client passes
    // just that one hash to getBlobs(). assembleAllFiles itself doesn't
    // promise to dedup lookups \u2014 it promises correct assembly given
    // a lookup. (2 calls = 1 per file, even though hash is shared.)
    assert.equal(calls, 2);
  });

  test("non-file changes are absent from the output map", () => {
    const h = sha256(BUF(1, 0xaa));
    const bulk: ManifestBulk = {
      maxRev: 1,
      changes: [
        { seq: 0, path: "/workspace/d",   op: "upsert", type: "dir",  mode: 0o40755, mtime: 1 },
        { seq: 1, path: "/workspace/old", op: "delete" },
        { seq: 2, path: "/workspace/f",   op: "upsert", type: "file", mode: 0o100644, mtime: 1,
          chunks: [{ hash: h, size: 1 }] },
      ],
    };
    const out = assembleAllFiles(bulk, () => new Uint8Array([0xaa]));
    assert.equal(out.size, 1);
    assert.ok(out.has("/workspace/f"));
  });
});
