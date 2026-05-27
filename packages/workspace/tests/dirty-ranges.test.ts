/**
 * Tests for the container-side dirty-range tracker (chunk-sync step 1).
 *
 * DirtyRanges remembers which 512 KiB-aligned chunks of each path have
 * been written to since the last pull, so the container can ship only
 * the touched chunks back to the DO instead of the whole file.
 *
 * Lifecycle:
 *   - `recordRange(path, offset, length)`  — FUSE write callback hook
 *   - `recordWholeFile(path)`               — full-file replace (cp, tar x)
 *   - `dirtyChunks(path)`                   — fully or partially dirty? (yes/no)
 *   - `dirtyChunkIndexes(path)`             — sorted Set<number>
 *   - `isWholeFile(path)`                   — must ship whole file, not chunks
 *   - `clear(path)`                         — after the pull confirms transit
 *   - `clearAll()`                          — after a full snapshot
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DirtyRanges } from "../src/container-sandbox/dirty-ranges.ts";
import { CHUNK_SIZE } from "../src/shared/index.ts";

describe("DirtyRanges", () => {
  test("a fresh tracker reports nothing dirty for any path", () => {
    const dr = new DirtyRanges();
    assert.equal(dr.dirtyChunks("/a"), false);
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")], []);
    assert.equal(dr.isWholeFile("/a"), false);
  });

  test("recordRange(0, 1) marks chunk 0 dirty", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 1);
    assert.equal(dr.dirtyChunks("/a"), true);
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")], [0]);
  });

  test("a write that straddles a chunk boundary marks both chunks", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", CHUNK_SIZE - 1, 2);
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")], [0, 1]);
  });

  test("a write whose end is exactly on a chunk boundary does NOT spill", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, CHUNK_SIZE);
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")], [0]);
  });

  test("an empty write (length 0) marks nothing", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 0);
    assert.equal(dr.dirtyChunks("/a"), false);
  });

  test("multiple writes union their chunk sets", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 100);                                  // chunk 0
    dr.recordRange("/a", 5 * CHUNK_SIZE, 100);                      // chunk 5
    dr.recordRange("/a", 2 * CHUNK_SIZE - 10, 20);                  // chunks 1 & 2
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")].sort((a, b) => a - b),
      [0, 1, 2, 5]);
  });

  test("recordWholeFile takes the whole-file path", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 100);
    dr.recordWholeFile("/a");
    assert.equal(dr.isWholeFile("/a"), true);
    // dirtyChunkIndexes is unspecified once we're in whole-file mode —
    // the consumer should branch on isWholeFile().  But dirtyChunks
    // must still report true so the file shows up in the pull.
    assert.equal(dr.dirtyChunks("/a"), true);
  });

  test("once whole-file, further range writes don't downgrade to chunk mode", () => {
    const dr = new DirtyRanges();
    dr.recordWholeFile("/a");
    dr.recordRange("/a", 100, 1);
    assert.equal(dr.isWholeFile("/a"), true);
  });

  test("clear(path) wipes both range-dirty and whole-file flags", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 10);
    dr.recordWholeFile("/b");
    dr.clear("/a");
    dr.clear("/b");
    assert.equal(dr.dirtyChunks("/a"), false);
    assert.equal(dr.dirtyChunks("/b"), false);
    assert.equal(dr.isWholeFile("/b"), false);
  });

  test("clearAll wipes every path", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 10);
    dr.recordRange("/b", 0, 10);
    dr.recordWholeFile("/c");
    dr.clearAll();
    for (const p of ["/a", "/b", "/c"]) {
      assert.equal(dr.dirtyChunks(p), false);
      assert.equal(dr.isWholeFile(p), false);
    }
  });

  test("paths are independent — clearing one keeps another", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 10);
    dr.recordRange("/b", 0, 10);
    dr.clear("/a");
    assert.equal(dr.dirtyChunks("/a"), false);
    assert.equal(dr.dirtyChunks("/b"), true);
  });

  test("dirtyChunkIndexes returns a snapshot (mutating it can't affect the tracker)", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 1);
    const idxs = dr.dirtyChunkIndexes("/a");
    // Should be safe to consume / mutate the returned collection without
    // disturbing the tracker.  Concrete shape (Set, array) is at the
    // implementation's discretion; the contract is "iterable, won't bite back".
    const copy = [...idxs];
    if (idxs instanceof Set) idxs.clear();
    assert.deepEqual([...dr.dirtyChunkIndexes("/a")], copy);
  });

  test("listPaths() enumerates paths that have any dirty state", () => {
    const dr = new DirtyRanges();
    dr.recordRange("/a", 0, 10);
    dr.recordRange("/b", 0, 10);
    dr.recordWholeFile("/c");
    assert.deepEqual([...dr.listPaths()].sort(), ["/a", "/b", "/c"]);
    dr.clear("/b");
    assert.deepEqual([...dr.listPaths()].sort(), ["/a", "/c"]);
  });

  test("large offsets work (16 MiB write at offset 100 MiB)", () => {
    const dr = new DirtyRanges();
    const off = 100 * 1024 * 1024;
    const len = 16 * 1024 * 1024;
    dr.recordRange("/big", off, len);
    const idxs = [...dr.dirtyChunkIndexes("/big")].sort((a, b) => a - b);
    // 100 MiB / 512 KiB = 200, 16 MiB / 512 KiB = 32, so chunks 200..231
    assert.equal(idxs[0], off / CHUNK_SIZE);
    assert.equal(idxs[idxs.length - 1], (off + len) / CHUNK_SIZE - 1);
    assert.equal(idxs.length, len / CHUNK_SIZE);
  });
});
