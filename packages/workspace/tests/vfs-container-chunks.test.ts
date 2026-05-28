/**
 * , piece 1: container Vfs mirrors the DO's
 * (path, idx) -> hash chunk index in memory.
 *
 * Files still live in `node.buf` (unchanged). Alongside it the node
 * carries `chunkHashes: (Uint8Array | null)[]` \u2014 one entry per
 * CHUNK_SIZE slice. A `null` entry means "the bytes were modified
 * since the last time this chunk's hash was computed"; the
 * `chunkHashAt(path, idx)` accessor fills it in lazily on demand.
 *
 * This piece is a behavioral no-op for everything outside the new
 * surface: existing pull tests still see the same wire format. Piece
 * 2 will consume `chunkHashAt` from the new manifest-aware pull.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { CHUNK_SIZE } from "../src/shared/index.ts";

const BUF = (len: number, fill: number) => Buffer.alloc(len, fill);
const sha256 = (b: Buffer) => new Uint8Array(createHash("sha256").update(b).digest());

describe("container Vfs chunk-hash index", () => {
  test("a newly-written file exposes one hash per CHUNK_SIZE slice", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    const file = BUF(CHUNK_SIZE * 2 + 100, 0xaa);
    vfs.putFile("/workspace/big", file);

    const hashes = vfs.chunkHashes("/workspace/big");
    assert.equal(hashes.length, 3, "two full chunks plus a 100-byte tail");
    assert.deepEqual(hashes[0], sha256(file.slice(0, CHUNK_SIZE)));
    assert.deepEqual(hashes[1], sha256(file.slice(CHUNK_SIZE, CHUNK_SIZE * 2)));
    assert.deepEqual(hashes[2], sha256(file.slice(CHUNK_SIZE * 2)));
  });

  test("identical content produces identical hashes regardless of path", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(1024, 0x77));
    vfs.putFile("/workspace/b", BUF(1024, 0x77));
    assert.deepEqual(
      vfs.chunkHashes("/workspace/a"),
      vfs.chunkHashes("/workspace/b"),
    );
  });

  test("an empty file has one zero-length chunk hash", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/empty", Buffer.alloc(0));
    const hashes = vfs.chunkHashes("/workspace/empty");
    assert.equal(hashes.length, 1);
    assert.deepEqual(hashes[0], sha256(Buffer.alloc(0)));
  });

  test("write() invalidates only the touched chunks; untouched chunks keep their hash", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(CHUNK_SIZE * 3, 0xaa));
    const before = vfs.chunkHashes("/workspace/big").map(h => h ? Buffer.from(h).toString("hex") : null);

    // Edit a single byte in chunk 1. Chunks 0 and 2 must keep their old hashes.
    vfs.write("/workspace/big", Buffer.from([0xff]), CHUNK_SIZE + 10);
    const after = vfs.chunkHashes("/workspace/big").map(h => h ? Buffer.from(h).toString("hex") : null);

    assert.equal(after.length, 3);
    assert.equal(after[0], before[0],   "chunk 0 untouched, hash stable");
    assert.notEqual(after[1], before[1], "chunk 1 modified, hash advanced");
    assert.equal(after[2], before[2],   "chunk 2 untouched, hash stable");
  });

  test("write() that straddles two chunks invalidates both", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(CHUNK_SIZE * 3, 0xaa));
    const before = vfs.chunkHashes("/workspace/big").map(h => Buffer.from(h!).toString("hex"));

    vfs.write("/workspace/big", Buffer.from([0x01, 0x02]), CHUNK_SIZE - 1);
    const after = vfs.chunkHashes("/workspace/big").map(h => Buffer.from(h!).toString("hex"));

    assert.notEqual(after[0], before[0]);
    assert.notEqual(after[1], before[1]);
    assert.equal(after[2],    before[2]);
  });

  test("truncate-shrink drops the chunks past the new size", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(CHUNK_SIZE * 3, 0xaa));
    assert.equal(vfs.chunkHashes("/workspace/big").length, 3);

    vfs.truncate("/workspace/big", CHUNK_SIZE + 5);  // keep chunk 0 in full, chunk 1 truncated to 5 bytes
    const hashes = vfs.chunkHashes("/workspace/big");
    assert.equal(hashes.length, 2);
    // The surviving partial chunk's hash matches the truncated content.
    const expected = BUF(5, 0xaa);
    assert.deepEqual(hashes[1], sha256(expected));
  });

  test("truncate-grow zero-fills and produces hashes for the new chunks", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(100, 0xaa));
    vfs.truncate("/workspace/big", CHUNK_SIZE * 2 + 50);
    const hashes = vfs.chunkHashes("/workspace/big");
    assert.equal(hashes.length, 3);
    // Chunk 1 is fully zero-filled; chunk 2 is 50 zero bytes.
    assert.deepEqual(hashes[1], sha256(BUF(CHUNK_SIZE, 0x00)));
    assert.deepEqual(hashes[2], sha256(BUF(50, 0x00)));
  });

  test("chunkHashes is idempotent: calling twice returns the same values", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(CHUNK_SIZE + 100, 0xaa));
    const a = vfs.chunkHashes("/workspace/big");
    const b = vfs.chunkHashes("/workspace/big");
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.deepEqual(a[i], b[i]);
    }
  });

  test("chunkHashes throws for a non-file path", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    assert.throws(() => vfs.chunkHashes("/workspace"));
    assert.throws(() => vfs.chunkHashes("/workspace/missing"));
  });
});
