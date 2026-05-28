/**
 * Tests for the container-side bulk-pull computation (commits 1 & 2).
 *
 * computeBulkPull is the pure core of `ContainerRpc.pullDirty` — given
 * a Vfs, an mtime watermark, and an ignore list, produce a sorted list
 * of VfsChangeLite records and one concatenated blob holding every
 * file's bytes back-to-back.
 *
 * computeDirtyNodes is the same selection in the older per-file shape
 * used by `getDirtyNodes`, kept for backward compatibility.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { computeBulkPull, computeDirtyNodes } from "../src/container-sandbox/pull.ts";

const TEXT = (s: string) => Buffer.from(s, "utf8");
const STR  = (u: Uint8Array) => Buffer.from(u).toString("utf8");

describe("computeBulkPull", () => {
  test("empty Vfs returns no changes and a 0-byte blob", () => {
    const vfs = new Vfs();
    const { changes, blob } = computeBulkPull(vfs, 0);
    assert.deepEqual(changes, []);
    assert.equal(blob.length, 0);
  });

  test("returns one change per dirtied file with content-bearing slices", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", TEXT("aaaa"));
    vfs.putFile("/workspace/b.txt", TEXT("bb"));

    const { changes, blob } = computeBulkPull(vfs, 0);
    // dirs + files all show up; we don't care about exact order beyond
    // mtime-sorted, just that the slice math is right.
    const files = changes.filter(c => c.type === "file");
    assert.equal(files.length, 2);
    assert.equal(blob.length, 4 + 2);
    for (const f of files) {
      const slice = blob.subarray(f.contentOffset!, f.contentOffset! + f.contentSize!);
      if (f.path.endsWith("a.txt")) assert.equal(STR(slice), "aaaa");
      else                          assert.equal(STR(slice), "bb");
    }
  });

  test("skips files whose rev is <= sinceRev (already-pulled watermark)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/old.txt", TEXT("x"));
    // Watermark snapshot: any subsequent mutation gets a strictly
    // larger rev. removed the dependency on wall-clock
    // mtime here — same-millisecond writes are still distinguishable.
    const watermark = vfs.currentRev();
    vfs.putFile("/workspace/new.txt", TEXT("y"));

    const { changes } = computeBulkPull(vfs, watermark);
    const paths = changes.filter(c => c.type === "file").map(c => c.path);
    assert.deepEqual(paths, ["/workspace/new.txt"]);
  });

  test("ignored segments are omitted from changes AND from the blob", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/node_modules");
    vfs.putFile("/workspace/node_modules/lib.js", TEXT("ignored content"));
    vfs.putFile("/workspace/keep.txt",            TEXT("kept content"));

    const { changes, blob } = computeBulkPull(vfs, 0, ["node_modules"]);
    const paths = changes.map(c => c.path);
    assert.ok(!paths.includes("/workspace/node_modules"));
    assert.ok(!paths.includes("/workspace/node_modules/lib.js"));
    assert.ok( paths.includes("/workspace/keep.txt"));
    // Blob must hold only "kept content" — nothing from node_modules.
    assert.equal(blob.length, "kept content".length);
    assert.equal(STR(blob), "kept content");
  });

  test("directories are reported but contribute no bytes to the blob", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/sub");
    vfs.putFile("/workspace/sub/a.txt", TEXT("hello"));

    const { changes, blob } = computeBulkPull(vfs, 0);
    const dirs  = changes.filter(c => c.type === "dir");
    const files = changes.filter(c => c.type === "file");
    assert.ok(dirs.length >= 1);
    assert.equal(files.length, 1);
    assert.equal(blob.length, "hello".length);
    // No dir should carry contentOffset / contentSize.
    for (const d of dirs) {
      assert.equal(d.contentOffset, undefined);
      assert.equal(d.contentSize,   undefined);
    }
  });

  test("tombstones past `since` come back as delete ops with no bytes", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/doomed.txt", TEXT("bye"));
    vfs.delete("/workspace/doomed.txt");

    const { changes, blob } = computeBulkPull(vfs, 0);
    // No live file, but a tombstone in the result.
    const ops = changes.map(c => ({ path: c.path, op: c.op }));
    assert.ok(ops.some(o => o.path === "/workspace/doomed.txt" && o.op === "delete"));
    assert.equal(blob.length, 0);
  });

  test("contentOffset/contentSize slices are contiguous, in result order", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    // Write three files with distinct sizes so off-by-one bugs surface.
    vfs.putFile("/workspace/x", TEXT("AAA"));
    vfs.putFile("/workspace/y", TEXT("BBBBBBB"));
    vfs.putFile("/workspace/z", TEXT("C"));

    const { changes, blob } = computeBulkPull(vfs, 0);
    const files = changes.filter(c => c.type === "file");
    // Walk the file changes in their result order; offsets must form a
    // strictly-increasing prefix-sum, and each slice must hold its file.
    let cursor = 0;
    const expectedContent: Record<string, string> = {
      "/workspace/x": "AAA",
      "/workspace/y": "BBBBBBB",
      "/workspace/z": "C",
    };
    for (const f of files) {
      assert.equal(f.contentOffset, cursor, `${f.path} offset`);
      assert.equal(f.contentSize, expectedContent[f.path].length, `${f.path} size`);
      const slice = blob.subarray(cursor, cursor + (f.contentSize ?? 0));
      assert.equal(STR(slice), expectedContent[f.path]);
      cursor += f.contentSize ?? 0;
    }
    assert.equal(cursor, blob.length);
  });

  test("symlinks are silently dropped (not part of the wire today)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.symlink("/workspace/link", "/workspace/target");
    const { changes } = computeBulkPull(vfs, 0);
    assert.ok(!changes.some(c => c.path === "/workspace/link"));
  });

  test("seq numbers are dense and start at 0", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", TEXT("a"));
    vfs.putFile("/workspace/b", TEXT("b"));
    const { changes } = computeBulkPull(vfs, 0);
    const seqs = changes.map(c => c.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(seqs[0], 0);
    assert.equal(seqs[seqs.length - 1], seqs.length - 1);
  });
});

describe("computeDirtyNodes", () => {
  test("returns the same paths as computeBulkPull (different shape)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", TEXT("a"));
    vfs.putFile("/workspace/b", TEXT("bb"));

    const a = computeBulkPull(vfs, 0).changes.map(c => c.path).sort();
    const b = computeDirtyNodes(vfs, 0).map(({ change }) => change.path).sort();
    assert.deepEqual(b, a);
  });

  test("ignored segments are omitted the same way", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/node_modules");
    vfs.putFile("/workspace/node_modules/x.js", TEXT("nope"));
    vfs.putFile("/workspace/y.js",              TEXT("yes"));

    const paths = computeDirtyNodes(vfs, 0, ["node_modules"])
      .map(({ change }) => change.path);
    assert.ok( paths.includes("/workspace/y.js"));
    assert.ok(!paths.includes("/workspace/node_modules"));
    assert.ok(!paths.includes("/workspace/node_modules/x.js"));
  });

  test("file entries carry their bytes; dirs and deletes do not", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/sub");
    vfs.putFile("/workspace/sub/a.txt", TEXT("hello"));
    vfs.putFile("/workspace/will-die",  TEXT("bye"));
    vfs.delete("/workspace/will-die");

    const out = computeDirtyNodes(vfs, 0);
    for (const { change, bytes } of out) {
      if (change.type === "file" && change.op === "upsert") {
        assert.ok(bytes instanceof Buffer, `${change.path} should have bytes`);
      } else {
        assert.equal(bytes, undefined, `${change.path} should not have bytes`);
      }
    }
  });
});
