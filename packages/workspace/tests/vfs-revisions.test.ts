/**
 * : replace mtime-based dirty tracking with a monotonic
 * container-side revision counter.
 *
 * The bug: mtimes have millisecond resolution. Two writes in the same
 * ms share a timestamp, so once `pullSinceMs` advances past that ms,
 * later same-ms writes are silently skipped on the next pull.
 *
 * The fix: every mutating op on the container Vfs increments an
 * internal `rev`. Node rows and tombstones each carry their stamp.
 * pullDirty / getDirtyNodes select by `rev > sinceRev` and return a
 * `maxRev` so the DO can advance its watermark unambiguously.
 *
 * mtime stays on the wire and on nodes \u2014 it's still useful for
 * display, FUSE stat, and existing consumers. Only the *dirty-tracking
 * watermark* changes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { computeBulkPull, computeDirtyNodes } from "../src/container-sandbox/pull.ts";

const BUF = (s: string) => Buffer.from(s, "utf8");

describe("Vfs revision counter", () => {
  test("currentRev starts at 0 and advances on every mutation", () => {
    const vfs = new Vfs();
    assert.equal(vfs.currentRev(), 0);
    vfs.mkdir("/workspace");
    const r1 = vfs.currentRev();
    assert.ok(r1 > 0, `expected rev > 0, got ${r1}`);
    vfs.putFile("/workspace/a.txt", BUF("hi"));
    const r2 = vfs.currentRev();
    assert.ok(r2 > r1, `expected rev to advance: ${r1} -> ${r2}`);
  });

  test("each mutation stamps the affected node with its rev", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("a"));
    const revA = vfs.get("/workspace/a.txt")!.rev;
    vfs.putFile("/workspace/b.txt", BUF("b"));
    const revB = vfs.get("/workspace/b.txt")!.rev;
    assert.ok(revA > 0);
    assert.ok(revB > revA, "the second write must carry a strictly larger rev");
  });

  test("delete records a tombstone with a monotonic rev", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("a"));
    const before = vfs.currentRev();
    vfs.delete("/workspace/a.txt");
    const after = vfs.currentRev();
    assert.ok(after > before);
    const tombs = vfs.getTombstones(before);
    assert.equal(tombs.length, 1);
    assert.equal(tombs[0].path, "/workspace/a.txt");
    assert.equal(tombs[0].rev, after);
  });

  test("applying=true does not advance the rev", () => {
    // Remote-pushed changes echo back through applyChanges; they must
    // not show up on the next outbound pull. Suppression is the same
    // semantics the existing mtime-based path had via `applying`.
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    const baseline = vfs.currentRev();
    vfs.applying = true;
    try {
      vfs.putFile("/workspace/remote.txt", BUF("remote"));
      vfs.delete("/workspace/remote.txt");
    } finally {
      vfs.applying = false;
    }
    assert.equal(vfs.currentRev(), baseline, "applying-mode mutations must not advance the rev");
  });
});

describe("Dirty tracking uses revisions, not mtimes", () => {
  test("two writes in the same wall-clock millisecond are both pulled", () => {
    // The original bug, reproduced. We stub Date.now() to lock the
    // clock so both putFile() calls produce identical mtimes, then
    // confirm both files come out of computeBulkPull with since=0.
    const realNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    (Date as { now(): number }).now = () => fakeNow;
    try {
      const vfs = new Vfs();
      vfs.mkdir("/workspace");
      vfs.putFile("/workspace/a.txt", BUF("a"));
      vfs.putFile("/workspace/b.txt", BUF("b"));
      // Both writes share an mtime \u2014 the very thing that used to lose
      // changes when the watermark advanced past it.
      assert.equal(vfs.get("/workspace/a.txt")!.mtime, fakeNow);
      assert.equal(vfs.get("/workspace/b.txt")!.mtime, fakeNow);

      // A pull from rev=0 sees both files.
      const r1 = computeBulkPull(vfs, 0);
      const fileChanges1 = r1.changes.filter(c => c.type === "file");
      assert.equal(fileChanges1.length, 2);

      // Now advance the watermark to the rev of the *first* file. The
      // second file's rev is strictly greater, so it must still appear.
      const sinceRev = vfs.get("/workspace/a.txt")!.rev;
      const r2 = computeBulkPull(vfs, sinceRev);
      const fileChanges2 = r2.changes.filter(c => c.type === "file");
      assert.equal(fileChanges2.length, 1, "the same-ms second write must still be pulled");
      assert.equal(fileChanges2[0].path, "/workspace/b.txt");
    } finally {
      (Date as { now(): number }).now = realNow;
    }
  });

  test("computeBulkPull returns the maxRev so the DO can advance unambiguously", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("a"));
    vfs.putFile("/workspace/b.txt", BUF("b"));
    const out = computeBulkPull(vfs, 0);
    assert.equal(out.maxRev, vfs.currentRev());
  });

  test("computeBulkPull on an empty pull still surfaces the current rev", () => {
    // Empty pull means \"nothing dirty since sinceRev\". maxRev must
    // equal sinceRev (or the current rev, which is the same if there
    // were no mutations). The DO uses this to bump its watermark even
    // when there's nothing to apply, so successive empty pulls don't
    // keep rescanning the same range.
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("a"));
    const sinceRev = vfs.currentRev();
    const out = computeBulkPull(vfs, sinceRev);
    assert.equal(out.changes.length, 0);
    assert.equal(out.maxRev, sinceRev);
  });

  test("computeDirtyNodes selects by rev too", () => {
    const realNow = Date.now;
    const fakeNow = 1_700_000_000_000;
    (Date as { now(): number }).now = () => fakeNow;
    try {
      const vfs = new Vfs();
      vfs.mkdir("/workspace");
      vfs.putFile("/workspace/a.txt", BUF("a"));
      const sinceRev = vfs.currentRev();
      vfs.putFile("/workspace/b.txt", BUF("b"));  // same mtime as a.txt
      const out = computeDirtyNodes(vfs, sinceRev);
      const files = out.filter(o => o.change.type === "file");
      assert.equal(files.length, 1);
      assert.equal(files[0].change.path, "/workspace/b.txt");
    } finally {
      (Date as { now(): number }).now = realNow;
    }
  });

  test("tombstones beyond sinceRev still show up in computeBulkPull", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("a"));
    const sinceRev = vfs.currentRev();
    vfs.delete("/workspace/a.txt");
    const out = computeBulkPull(vfs, sinceRev);
    const deletes = out.changes.filter(c => c.op === "delete");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].path, "/workspace/a.txt");
  });
});
