/**
 * , piece 2: manifest-aware pull on the container.
 *
 * `computeManifestPull(vfs, sinceRev, ignore)` returns the same
 * change-set shape as `computeBulkPull`, but every file change carries
 * `chunks: { hash, size }[]` instead of inline bytes. The DO side
 * (piece 3) calls hasBlobs/getBlobs to fetch just the bytes it lacks.
 *
 * This piece is the pure computation. The RPC surface and the DO-side
 * apply flow follow in pieces 3 and 4.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { computeManifestPull, getBlobs } from "../src/container-sandbox/pull.ts";
import { CHUNK_SIZE } from "../src/shared/index.ts";

const BUF = (len: number, fill: number) => Buffer.alloc(len, fill);
const sha256 = (b: Buffer) => new Uint8Array(createHash("sha256").update(b).digest());
const hex    = (u: Uint8Array) => Buffer.from(u).toString("hex");

describe("computeManifestPull", () => {
  test("file upserts carry an ordered chunks array of (hash, size)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    const payload = BUF(CHUNK_SIZE + 100, 0xaa);
    vfs.putFile("/workspace/big", payload);

    const out = computeManifestPull(vfs, 0);
    const file = out.changes.find(c => c.op === "upsert" && c.type === "file" && c.path === "/workspace/big")!;
    assert.ok(file.chunks, "file change must carry chunks");
    assert.equal(file.chunks!.length, 2);
    assert.deepEqual(file.chunks![0].hash, sha256(payload.slice(0, CHUNK_SIZE)));
    assert.equal(file.chunks![0].size, CHUNK_SIZE);
    assert.deepEqual(file.chunks![1].hash, sha256(payload.slice(CHUNK_SIZE)));
    assert.equal(file.chunks![1].size, 100);
  });

  test("dir upserts carry no chunks; mode and mtime present", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/dir", 0o40711);
    const out = computeManifestPull(vfs, 0);
    const dir = out.changes.find(c => c.type === "dir" && c.path === "/workspace/dir")!;
    assert.ok(dir);
    assert.equal(dir.mode, 0o40711);
    assert.equal((dir as { chunks?: unknown }).chunks, undefined);
  });

  test("delete tombstones surface as op:'delete' with just the path", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(10, 0x77));
    const sinceRev = vfs.currentRev();
    vfs.delete("/workspace/a");
    const out = computeManifestPull(vfs, sinceRev);
    const del = out.changes.find(c => c.op === "delete");
    assert.ok(del);
    assert.equal(del!.path, "/workspace/a");
  });

  test("identical content at two paths shares hashes \u2014 wire-level dedup", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(1024, 0x55));
    vfs.putFile("/workspace/b", BUF(1024, 0x55));
    const out = computeManifestPull(vfs, 0);
    const files = out.changes.filter(c => c.op === "upsert" && c.type === "file");
    assert.equal(files.length, 2);
    assert.equal(hex(files[0].chunks![0].hash), hex(files[1].chunks![0].hash),
      "two paths with identical content must reference the same chunk hash");
  });

  test("respects sinceRev: clean files don't show up", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/clean", BUF(10, 0x77));
    const sinceRev = vfs.currentRev();
    vfs.putFile("/workspace/dirty", BUF(20, 0x88));
    const out = computeManifestPull(vfs, sinceRev);
    const paths = out.changes.filter(c => c.op === "upsert").map(c => c.path);
    assert.deepEqual(paths, ["/workspace/dirty"]);
  });

  test("respects ignore globs", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/node_modules");
    vfs.putFile("/workspace/node_modules/lib.js", BUF(10, 0x77));
    vfs.putFile("/workspace/keep.txt",            BUF(10, 0x88));
    const out = computeManifestPull(vfs, 0, ["node_modules"]);
    const paths = out.changes.map(c => c.path);
    assert.ok(!paths.some(p => p.includes("node_modules")));
    assert.ok(paths.includes("/workspace/keep.txt"));
  });

  test("returns maxRev so the receiver can advance its watermark", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(10, 0x77));
    const out = computeManifestPull(vfs, 0);
    assert.equal(out.maxRev, vfs.currentRev());
  });
});

describe("getBlobs serves byte slices for the requested hashes", () => {
  test("returns the bytes for every requested hash, in order", async () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    const payload = BUF(CHUNK_SIZE + 100, 0xaa);
    vfs.putFile("/workspace/big", payload);
    const hashes = vfs.chunkHashes("/workspace/big");

    const blobs = getBlobs(vfs, hashes);
    assert.equal(blobs.length, 2);
    assert.deepEqual(blobs[0], payload.slice(0, CHUNK_SIZE));
    assert.deepEqual(blobs[1], payload.slice(CHUNK_SIZE));
  });

  test("dedups duplicate hash requests \u2014 the caller asks for what it lacks", async () => {
    // hasBlobs returns the missing set, so getBlobs only ever sees
    // distinct hashes. We still pin down that asking for the same
    // hash twice returns the same bytes twice (identity, not surprise).
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(10, 0x77));
    const h = vfs.chunkHashes("/workspace/a")[0];
    const blobs = getBlobs(vfs, [h, h]);
    assert.equal(blobs.length, 2);
    assert.deepEqual(blobs[0], blobs[1]);
  });

  test("throws on a hash the container does not have", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    const ghost = new Uint8Array(32);  // all zeros, no chunk hashes to this
    assert.throws(() => getBlobs(vfs, [ghost]));
  });
});
