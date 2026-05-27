/**
 * Tests for the container-side Vfs integration with DirtyRanges
 * (chunk-sync step 2).  The Vfs owns a DirtyRanges instance and is
 * responsible for keeping it correct under whole-file writes, deletes,
 * and remote-pushed applyChanges.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";

const B = (s: string) => Buffer.from(s, "utf8");

describe("Vfs.dirty (DirtyRanges integration)", () => {
  test("a fresh Vfs has nothing dirty", () => {
    const vfs = new Vfs();
    assert.equal([...vfs.dirty.listPaths()].length, 0);
  });

  test("putFile marks the path whole-file dirty", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", B("hello"));
    assert.equal(vfs.dirty.isWholeFile("/workspace/a.txt"), true);
    assert.equal(vfs.dirty.dirtyChunks("/workspace/a.txt"), true);
  });

  test("delete clears the path from the tracker", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/gone", B("bye"));
    vfs.delete("/workspace/gone");
    assert.equal(vfs.dirty.dirtyChunks("/workspace/gone"), false);
    assert.equal(vfs.dirty.isWholeFile("/workspace/gone"), false);
  });

  test("delete on a subtree clears every path under it", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/sub");
    vfs.putFile("/workspace/sub/a", B("a"));
    vfs.putFile("/workspace/sub/b", B("b"));
    vfs.delete("/workspace/sub");
    assert.equal(vfs.dirty.dirtyChunks("/workspace/sub/a"), false);
    assert.equal(vfs.dirty.dirtyChunks("/workspace/sub/b"), false);
  });

  test("applying=true suppresses dirty-range recording (remote-pushed writes)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.applying = true;
    try {
      vfs.putFile("/workspace/from-do.txt", B("pushed"));
    } finally {
      vfs.applying = false;
    }
    // The DO already has these bytes — they must not bounce back on
    // the next pull.
    assert.equal(vfs.dirty.dirtyChunks("/workspace/from-do.txt"), false);
  });

  test("applying=true suppresses delete-side clears too", () => {
    // A remote-pushed delete must not interfere with a local dirty
    // state we haven't pulled yet.  We seed a local write, then apply
    // a remote delete with applying=true; the local state should
    // survive (so the next pull can ship it).
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/conflicted", B("local"));   // marks dirty
    assert.equal(vfs.dirty.isWholeFile("/workspace/conflicted"), true);
    vfs.applying = true;
    try { vfs.delete("/workspace/conflicted"); } finally { vfs.applying = false; }
    // The node is gone but DirtyRanges keeps the local intent.  This
    // matches the existing tombstone-suppression contract (applying=true
    // doesn't record tombstones; it shouldn't undo local dirty-state
    // either).
    //
    // NB: this is the conservative choice — if we change our mind and
    // decide remote deletes should overwrite local dirty state, this
    // test pins the current behaviour so the change is intentional.
    assert.equal(vfs.dirty.isWholeFile("/workspace/conflicted"), true);
  });

  test("repeated putFile keeps the path whole-file dirty (idempotent)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/x", B("v1"));
    vfs.putFile("/workspace/x", B("v2"));
    assert.equal(vfs.dirty.isWholeFile("/workspace/x"), true);
    assert.deepEqual([...vfs.dirty.listPaths()], ["/workspace/x"]);
  });
});

describe("Vfs.write (range writes from the FUSE driver)", () => {
  test("a single byte write at offset 0 marks chunk 0 only", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", B("x"));   // whole-file
    vfs.dirty.clear("/workspace/a");        // simulate post-pull
    vfs.write("/workspace/a", B("y"), 0);
    assert.equal(vfs.dirty.isWholeFile("/workspace/a"), false);
    assert.deepEqual([...vfs.dirty.dirtyChunkIndexes("/workspace/a")], [0]);
  });

  test("write that straddles a chunk boundary marks both chunks", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    // Need a file at least 1 chunk long to make boundary writes meaningful.
    vfs.putFile("/workspace/a", Buffer.alloc(1024 * 1024, 0xaa)); // 1 MiB
    vfs.dirty.clear("/workspace/a");
    // Write at byte CHUNK_SIZE - 1 of length 2: touches chunks 0 and 1.
    vfs.write("/workspace/a", B("zz"), 512 * 1024 - 1);
    assert.deepEqual(
      [...vfs.dirty.dirtyChunkIndexes("/workspace/a")].sort((a, b) => a - b),
      [0, 1]
    );
  });

  test("write against a non-existent path is a no-op for tracking", () => {
    const vfs = new Vfs();
    vfs.write("/workspace/never", B("x"), 0);
    assert.equal(vfs.dirty.dirtyChunks("/workspace/never"), false);
  });

  test("write does NOT downgrade a whole-file dirty path back to chunk mode", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", Buffer.alloc(1024 * 1024, 0));  // whole-file
    vfs.write("/workspace/a", B("y"), 100);                       // partial
    assert.equal(vfs.dirty.isWholeFile("/workspace/a"), true);
  });

  test("applying=true suppresses range recording", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", B("xx"));
    vfs.dirty.clear("/workspace/a");
    vfs.applying = true;
    try { vfs.write("/workspace/a", B("y"), 0); } finally { vfs.applying = false; }
    assert.equal(vfs.dirty.dirtyChunks("/workspace/a"), false);
  });
});

describe("Vfs.truncate", () => {
  test("truncate marks the path whole-file dirty (size change semantics)", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", Buffer.alloc(1024, 0xaa));
    vfs.dirty.clear("/workspace/a");
    vfs.truncate("/workspace/a", 100);
    assert.equal(vfs.dirty.isWholeFile("/workspace/a"), true);
  });

  test("applying=true suppresses truncate-side recording", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a", Buffer.alloc(1024, 0xaa));
    vfs.dirty.clear("/workspace/a");
    vfs.applying = true;
    try { vfs.truncate("/workspace/a", 100); } finally { vfs.applying = false; }
    assert.equal(vfs.dirty.dirtyChunks("/workspace/a"), false);
  });
});
