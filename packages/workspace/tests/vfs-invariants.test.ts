/**
 * : Vfs must enforce filesystem-shape invariants on direct
 * (non-applying) callers, so we never end up with a file row and a
 * directory row that conflict on the same path or any of its ancestors.
 *
 * Direct callers get a thrown `VfsError` with a stable `.code`. The
 * sync apply path keeps its current "remote is authoritative" stance
 * by setting `applying = true`; in that mode the invariants relax to
 * an implicit replace, because the source of truth is the remote
 * change log, not the local tree.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs, VfsError } from "../src/vfs.ts";
import { makeShimStorage } from "./sql-shim.ts";

const TEXT = (s: string) => new TextEncoder().encode(s);

function makeVfs() {
  const storage = makeShimStorage();
  const vfs = new Vfs(storage.sql as unknown as SqlStorage);
  return { vfs, storage };
}

function capture(fn: () => unknown): VfsError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof VfsError)) throw new Error(`expected VfsError, got ${e}`);
    return e;
  }
  throw new Error("expected throw");
}

describe("Vfs tree invariants \u2014 direct callers", () => {
  test("mkdir over an existing file throws FILE_AT_DIR_PATH", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a", TEXT("file"));
    const err = capture(() => vfs.mkdir("/workspace/a"));
    assert.equal(err.code, "FILE_AT_DIR_PATH");
    // Original row is unchanged.
    assert.equal(vfs.stat("/workspace/a")?.type, "file");
  });

  test("mkdir on an existing directory is idempotent (no throw, same row)", () => {
    const { vfs } = makeVfs();
    vfs.mkdir("/workspace/d", 0o40755);
    const before = vfs.stat("/workspace/d");
    vfs.mkdir("/workspace/d");
    const after = vfs.stat("/workspace/d");
    assert.deepEqual(after, before, "second mkdir must not mutate the row");
  });

  test("writeFile over an existing directory throws DIR_AT_FILE_PATH", () => {
    const { vfs } = makeVfs();
    vfs.mkdir("/workspace/dir");
    const err = capture(() => vfs.writeFile("/workspace/dir", TEXT("x")));
    assert.equal(err.code, "DIR_AT_FILE_PATH");
    // Directory still intact.
    assert.equal(vfs.stat("/workspace/dir")?.type, "dir");
  });

  test("writeChunks over an existing directory throws DIR_AT_FILE_PATH", () => {
    const { vfs } = makeVfs();
    vfs.mkdir("/workspace/dir");
    const err = capture(() =>
      vfs.writeChunks("/workspace/dir", [{ idx: 0, bytes: TEXT("x") }]),
    );
    assert.equal(err.code, "DIR_AT_FILE_PATH");
  });

  test("writeFile under a file parent throws PARENT_NOT_DIR", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a", TEXT("file"));
    const err = capture(() => vfs.writeFile("/workspace/a/child.txt", TEXT("x")));
    assert.equal(err.code, "PARENT_NOT_DIR");
    // The would-be child was not created.
    assert.equal(vfs.stat("/workspace/a/child.txt"), null);
  });

  test("mkdir under a file parent throws PARENT_NOT_DIR", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a", TEXT("file"));
    const err = capture(() => vfs.mkdir("/workspace/a/sub"));
    assert.equal(err.code, "PARENT_NOT_DIR");
  });

  test("writeStub under a file parent throws PARENT_NOT_DIR", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a", TEXT("file"));
    const err = capture(() =>
      vfs.writeStub("/workspace/a/stub", 0o100644, 1, "/workspace/a", 0),
    );
    assert.equal(err.code, "PARENT_NOT_DIR");
  });

  test("nested mkdir creates intermediate directories normally", () => {
    const { vfs } = makeVfs();
    vfs.mkdir("/workspace/a/b/c");
    assert.equal(vfs.stat("/workspace/a")?.type,     "dir");
    assert.equal(vfs.stat("/workspace/a/b")?.type,   "dir");
    assert.equal(vfs.stat("/workspace/a/b/c")?.type, "dir");
  });
});

describe("Vfs tree invariants \u2014 apply path (applying = true)", () => {
  // Remote sync is authoritative: when applying remote changes, a
  // type mismatch means the local tree is stale and must be replaced,
  // not rejected. The existing applying flag already opts the apply
  // path out of seq bumps and tombstones; it now also relaxes the
  // tree invariants.

  test("applying lets mkdir replace a file row (file \u2192 dir)", () => {
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/p", TEXT("was a file"));
    vfs.applying = true;
    try {
      vfs.mkdir("/workspace/p");
    } finally {
      vfs.applying = false;
    }
    assert.equal(vfs.stat("/workspace/p")?.type, "dir");
  });

  test("applying lets writeFile replace a dir row (dir \u2192 file)", () => {
    const { vfs } = makeVfs();
    vfs.mkdir("/workspace/p");
    vfs.applying = true;
    try {
      vfs.writeFile("/workspace/p", TEXT("now a file"));
    } finally {
      vfs.applying = false;
    }
    assert.equal(vfs.stat("/workspace/p")?.type, "file");
    assert.deepEqual(vfs.readFile("/workspace/p"), TEXT("now a file"));
  });

  test("applying does NOT relax invariants for a file-under-file parent that's still valid post-replace", () => {
    // Concretely: when applying a stream of changes that converts /a
    // from file to dir, then writes /a/child, the intermediate state
    // must allow the child write. The cleanest way is for the
    // applying-mode ensureParentDirs to coerce file parents to dirs.
    const { vfs } = makeVfs();
    vfs.writeFile("/workspace/a", TEXT("was a file"));
    vfs.applying = true;
    try {
      vfs.writeFile("/workspace/a/child", TEXT("x"));
    } finally {
      vfs.applying = false;
    }
    assert.equal(vfs.stat("/workspace/a")?.type,       "dir");
    assert.equal(vfs.stat("/workspace/a/child")?.type, "file");
  });
});
