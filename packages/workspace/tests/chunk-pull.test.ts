/**
 * Tests for chunk-mode bulk pulls (chunk-sync step 3).
 *
 * computeBulkPull consults vfs.dirty.isWholeFile(path) and decides per
 * file whether to ship the whole file or only the touched chunks.
 *
 * Wire shape:
 *   - whole-file mode  (current behaviour): contentOffset + contentSize
 *   - chunk mode       (new):                chunks: [{ idx, offset, size }]
 *
 * The DO-side applyChangesSync (step-3 work below) consumes both.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { computeBulkPull } from "../src/container-sandbox/pull.ts";
import { CHUNK_SIZE } from "../src/shared/index.ts";

const BUF = (size: number, fill: number) => Buffer.alloc(size, fill);

function findChange(out: ReturnType<typeof computeBulkPull>, path: string) {
  return out.changes.find(c => c.path === path);
}

describe("computeBulkPull (chunk mode)", () => {
  test("a fresh whole-file write ships in whole-file mode (no chunks field)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(100, 0xaa));

    const out = computeBulkPull(vfs, 0);
    const c = findChange(out, "/workspace/a")!;
    assert.equal(c.type, "file");
    assert.equal(c.chunks, undefined);
    assert.equal(c.contentSize, 100);
  });

  test("a range write on a previously-clean file ships chunks-only", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    // Put a 1.5 MiB file (chunks 0, 1, and the start of 2).
    // 2 full chunks so chunk 1 is exactly CHUNK_SIZE bytes long.
    const initial = BUF(CHUNK_SIZE * 2, 0xaa);
    vfs.putFile("/workspace/big", initial);
    // Simulate a successful pull that landed the whole file on the DO.
    vfs.dirty.clear("/workspace/big");

    // Edit a single byte at the start of chunk 1.
    const since = Date.now();
    // sleep 5ms so the next mtime > since
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    return sleep(5).then(() => {
      vfs.write("/workspace/big", Buffer.from([0xff]), CHUNK_SIZE);

      const out = computeBulkPull(vfs, since);
      const c = findChange(out, "/workspace/big")!;
      // Whole-file fields should NOT be set in chunk mode.
      assert.equal(c.contentOffset, undefined);
      assert.equal(c.contentSize,   undefined);
      // chunks should hold exactly one entry naming idx=1.
      assert.ok(Array.isArray(c.chunks));
      assert.equal(c.chunks!.length, 1);
      assert.equal(c.chunks![0].idx, 1);
      assert.equal(c.chunks![0].size, CHUNK_SIZE);
      // The chunk's slice in the blob holds chunk 1 of the file.
      const slice = out.blob.subarray(c.chunks![0].offset, c.chunks![0].offset + c.chunks![0].size);
      assert.equal(slice.length, CHUNK_SIZE);
      // First byte is the one we wrote (0xff); rest is the original 0xaa.
      assert.equal(slice[0], 0xff);
      assert.equal(slice[1], 0xaa);
    });
  });

  test("a write straddling two chunks ships both chunks, in idx order", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(Math.floor(CHUNK_SIZE * 2.5), 0xaa));
    vfs.dirty.clear("/workspace/big");
    const since = Date.now();
    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      // Write 2 bytes starting one byte before the chunk-1 boundary.
      vfs.write("/workspace/big", Buffer.from([0x11, 0x22]), CHUNK_SIZE - 1);

      const out = computeBulkPull(vfs, since);
      const c = findChange(out, "/workspace/big")!;
      assert.ok(Array.isArray(c.chunks));
      const idxs = c.chunks!.map(k => k.idx).sort((a, b) => a - b);
      assert.deepEqual(idxs, [0, 1]);
      // Each chunk's size is CHUNK_SIZE except possibly the last one,
      // which is the trailing chunk and may be short — but here both
      // 0 and 1 are full because the file is 2.5 chunks.
      for (const k of c.chunks!) {
        assert.equal(k.size, CHUNK_SIZE);
        const slice = out.blob.subarray(k.offset, k.offset + k.size);
        assert.equal(slice.length, CHUNK_SIZE);
      }
    });
  });

  test("a write into the last (short) chunk ships a short slice", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    // File is exactly chunk 0 + 10 bytes of chunk 1.
    const tailBytes = 10;
    vfs.putFile("/workspace/short-tail", BUF(CHUNK_SIZE + tailBytes, 0xaa));
    vfs.dirty.clear("/workspace/short-tail");
    const since = Date.now();
    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      vfs.write("/workspace/short-tail", Buffer.from([0xff]), CHUNK_SIZE + 5);
      const out = computeBulkPull(vfs, since);
      const c = findChange(out, "/workspace/short-tail")!;
      assert.ok(Array.isArray(c.chunks));
      assert.equal(c.chunks!.length, 1);
      const k = c.chunks![0];
      assert.equal(k.idx, 1);
      assert.equal(k.size, tailBytes);
    });
  });

  test("whole-file dirty wins over partial: putFile after a range edit ships whole file", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/x", BUF(CHUNK_SIZE * 2, 0xaa));
    vfs.dirty.clear("/workspace/x");
    const since = Date.now();
    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      vfs.write("/workspace/x", Buffer.from([0xff]), 0);
      // Subsequent whole-file replace.  Whole-file wins.
      vfs.putFile("/workspace/x", BUF(CHUNK_SIZE * 2, 0xbb));
      const out = computeBulkPull(vfs, since);
      const c = findChange(out, "/workspace/x")!;
      assert.equal(c.chunks, undefined);
      assert.equal(c.contentSize, CHUNK_SIZE * 2);
    });
  });

  test("blob layout: chunk slices and whole-file slices share the same blob", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    // file1: range-dirty (chunk-mode)
    vfs.putFile("/workspace/file1", BUF(CHUNK_SIZE * 2, 0xaa));
    vfs.dirty.clear("/workspace/file1");
    // file2: brand new (whole-file mode)
    const since = Date.now();
    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      vfs.write("/workspace/file1", Buffer.from([0x55]), CHUNK_SIZE);  // dirties chunk 1
      vfs.putFile("/workspace/file2", Buffer.from("brand new"));        // whole-file
      const out = computeBulkPull(vfs, since);
      // Each non-overlapping chunk + whole-file slice should sit in the
      // blob without overlap, in some sorted order.  Walk the changes
      // and verify every named slice falls within [0, blob.length].
      const seen: Array<[number, number]> = [];
      for (const c of out.changes) {
        if (c.chunks) {
          for (const k of c.chunks) seen.push([k.offset, k.offset + k.size]);
        } else if (c.contentSize) {
          seen.push([c.contentOffset!, c.contentOffset! + c.contentSize]);
        }
      }
      seen.sort((a, b) => a[0] - b[0]);
      let prevEnd = 0;
      for (const [s, e] of seen) {
        assert.ok(s >= prevEnd, `slice [${s}, ${e}) overlaps previous end ${prevEnd}`);
        assert.ok(e <= out.blob.length, `slice [${s}, ${e}) past blob length ${out.blob.length}`);
        prevEnd = e;
      }
    });
  });
});

describe("dirty-state lifecycle around pulls", () => {
  test("computeBulkPull does NOT mutate the dirty tracker", () => {
    // The choice in this codebase: compute is read-only.  Workspace.ts
    // is responsible for clearing dirty state after applyChangesSync
    // lands successfully on the DO side.  This test pins that contract.
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", BUF(CHUNK_SIZE * 2, 0xaa));
    vfs.dirty.clear("/workspace/a");
    const since = Date.now();
    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      vfs.write("/workspace/a", Buffer.from([0xff]), CHUNK_SIZE);
      computeBulkPull(vfs, since);
      // After compute, the dirty state should still be there: we didn't
      // get the ack yet.
      assert.equal(vfs.dirty.dirtyChunks("/workspace/a"), true);
      assert.deepEqual([...vfs.dirty.dirtyChunkIndexes("/workspace/a")], [1]);
    });
  });
});

describe("end-to-end: whole-file pull then chunk pull", () => {
  test("after a whole-file pull, a later range write ships chunks-only", () => {
    // This mimics the live flow: the container ships a whole file on
    // the first pull, the DO commits it, then the container ships only
    // the touched chunks on the next pull.  We don't have access to
    // pullDirty's side-effect clear here (it's on the RPC class), so
    // we simulate it by clearing dirty state explicitly between rounds.
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/big", BUF(CHUNK_SIZE * 2, 0xaa));

    const r1 = computeBulkPull(vfs, 0);
    const c1 = findChange(r1, "/workspace/big")!;
    assert.equal(c1.contentSize, CHUNK_SIZE * 2);
    assert.equal(c1.chunks, undefined);

    // Imagine the RPC wrapper clears dirty state after compute (it does).
    for (const c of r1.changes) {
      if (c.op === "upsert" && c.type === "file") vfs.dirty.clear(c.path);
    }
    const since = c1.mtime!;

    return new Promise<void>(r => setTimeout(r, 5)).then(() => {
      vfs.write("/workspace/big", Buffer.from([0xff]), CHUNK_SIZE);

      const r2 = computeBulkPull(vfs, since);
      const c2 = findChange(r2, "/workspace/big")!;
      // Chunk mode now.
      assert.equal(c2.contentSize, undefined);
      assert.ok(Array.isArray(c2.chunks));
      assert.deepEqual(c2.chunks!.map(k => k.idx), [1]);
      // Blob now holds only chunk 1's bytes, not the whole file.
      assert.equal(r2.blob.length, CHUNK_SIZE);
    });
  });
});
