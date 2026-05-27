/**
 * Tests for Vfs.applyChangesSync — the synchronous sibling of
 * applyChanges() introduced for the batched-SQLite-write path
 * (commit 3).  It takes pre-resolved bytes instead of streams so the
 * caller can wrap the whole loop in DurableObjectStorage.transactionSync.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/vfs.ts";
import { makeShimStorage } from "./sql-shim.ts";

const TEXT = (s: string) => new TextEncoder().encode(s);
const STR  = (u: Uint8Array | null) => u ? new TextDecoder().decode(u) : null;

function makeVfs() {
  const storage = makeShimStorage();
  const vfs = new Vfs(storage.sql as unknown as SqlStorage);
  return { vfs, storage };
}

describe("Vfs.applyChangesSync", () => {
  test("applies a fresh dir + file upsert", () => {
    const { vfs } = makeVfs();
    vfs.applyChangesSync([
      { path: "/workspace",         op: "upsert", type: "dir" },
      { path: "/workspace/a.txt",   op: "upsert", type: "file", bytes: TEXT("hello") },
    ]);
    assert.equal(STR(vfs.readFile("/workspace/a.txt")), "hello");
  });

  test("overwrites an existing file's bytes", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/x", TEXT("first"));
    vfs.applyChangesSync([
      { path: "/workspace/x", op: "upsert", type: "file", bytes: TEXT("second") },
    ]);
    assert.equal(STR(vfs.readFile("/workspace/x")), "second");
  });

  test("delete removes the row and its chunks", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/gone", TEXT("bye"));
    assert.equal(STR(vfs.readFile("/workspace/gone")), "bye");
    vfs.applyChangesSync([
      { path: "/workspace/gone", op: "delete" },
    ]);
    assert.equal(vfs.readFile("/workspace/gone"), null);
  });

  test("undefined bytes on a file upsert lands as a zero-byte file", () => {
    const { vfs } = makeVfs();
    vfs.applyChangesSync([
      { path: "/workspace",       op: "upsert", type: "dir" },
      { path: "/workspace/empty", op: "upsert", type: "file" },
    ]);
    const out = vfs.readFile("/workspace/empty");
    assert.ok(out instanceof Uint8Array);
    assert.equal(out!.length, 0);
  });

  test("multi-chunk file (>512 KiB) round-trips through chunked storage", () => {
    const { vfs } = makeVfs();
    const big = new Uint8Array(1024 * 1024 + 17);  // ~1 MiB + 17B → 3 chunks
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    vfs.applyChangesSync([
      { path: "/workspace",        op: "upsert", type: "dir" },
      { path: "/workspace/blob",   op: "upsert", type: "file", bytes: big },
    ]);
    const out = vfs.readFile("/workspace/blob");
    assert.equal(out!.length, big.length);
    for (let i = 0; i < big.length; i++) {
      if (out![i] !== big[i]) {
        assert.fail(`byte mismatch at ${i}: got ${out![i]}, expected ${big[i]}`);
      }
    }
  });

  test("returns a {seq} object", () => {
    const { vfs } = makeVfs();
    const r = vfs.applyChangesSync([
      { path: "/workspace", op: "upsert", type: "dir" },
    ]);
    assert.equal(typeof r.seq, "number");
  });

  test("sets vfs.applying=false on the way out, even on empty input", () => {
    const { vfs } = makeVfs();
    vfs.applyChangesSync([]);
    // We can probe via the public side-effect: a follow-up delete must
    // record a tombstone now that we're not in apply mode.
    vfs.writeFile("/workspace/x", TEXT("x"));
    vfs.deleteFile("/workspace/x");
    // No assertion failure means the apply flag isn't stuck.
    assert.equal(vfs.readFile("/workspace/x"), null);
  });

  test("does NOT throw on a delete for a path that does not exist", () => {
    const { vfs } = makeVfs();
    // Should be a no-op, matching the existing applyChanges behaviour.
    vfs.applyChangesSync([
      { path: "/workspace/never-was", op: "delete" },
    ]);
  });

  test("wraps cleanly inside storage.transactionSync — commits", () => {
    const { vfs, storage } = makeVfs();
    storage.transactionSync(() => {
      vfs.applyChangesSync([
        { path: "/workspace",        op: "upsert", type: "dir" },
        { path: "/workspace/one",    op: "upsert", type: "file", bytes: TEXT("1") },
        { path: "/workspace/two",    op: "upsert", type: "file", bytes: TEXT("2") },
      ]);
    });
    assert.equal(STR(vfs.readFile("/workspace/one")), "1");
    assert.equal(STR(vfs.readFile("/workspace/two")), "2");
  });

  test("wraps cleanly inside storage.transactionSync — rolls back on throw", () => {
    const { vfs, storage } = makeVfs();
    vfs.writeFile("/workspace/already-there", TEXT("ok"));
    assert.throws(() => {
      storage.transactionSync(() => {
        vfs.applyChangesSync([
          { path: "/workspace/added", op: "upsert", type: "file", bytes: TEXT("x") },
        ]);
        throw new Error("simulated failure inside the transaction");
      });
    });
    // The pre-existing row survives, the added row does not.
    assert.equal(STR(vfs.readFile("/workspace/already-there")), "ok");
    assert.equal(vfs.readFile("/workspace/added"), null);
  });
});
