/**
 * : FUSE getattr() must return a stable mtime that tracks
 * actual VFS mutations, not `new Date()` at call time.
 *
 * Build tools and caches rely on mtime not changing between back-to-back
 * stats of an unchanged file. The fix is for statDir/statFile to take
 * the node's recorded mtime.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { makeFuseOps } from "../src/container-sandbox/fuse-driver.ts";

const MOUNT = "/workspace";

function call<T>(fn: (cb: (errno: number, result: T) => void) => void): { errno: number; result: T } {
  let captured: { errno: number; result: T } | undefined;
  fn((errno, result) => { captured = { errno, result }; });
  if (!captured) throw new Error("FUSE callback never fired synchronously");
  return captured;
}

describe("FUSE getattr returns node-backed mtime", () => {
  test("file mtime tracks the node, not the wall clock", () => {
    const vfs = new Vfs();
    vfs.putFile("/workspace/a.txt", Buffer.from("hello"), 0o100644);
    const ops = makeFuseOps(vfs, MOUNT);

    const recordedMtime = vfs.get("/workspace/a.txt")!.mtime;

    // Stat once, wait long enough that wall-clock has moved by at least
    // a millisecond, and stat again. Both responses must report the
    // same mtime — the one recorded on the node.
    const first  = call<any>(cb => ops.getattr("/a.txt", cb));
    const before = Date.now();
    while (Date.now() === before) { /* spin one ms */ }
    const second = call<any>(cb => ops.getattr("/a.txt", cb));

    assert.equal(first.errno, 0);
    assert.equal(second.errno, 0);
    assert.equal(first.result.mtime.getTime(), recordedMtime);
    assert.equal(second.result.mtime.getTime(), recordedMtime,
      "back-to-back getattr calls must report the same mtime for an unchanged file");
  });

  test("directory mtime tracks the node, not the wall clock", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace/dir");
    const ops = makeFuseOps(vfs, MOUNT);

    const recordedMtime = vfs.get("/workspace/dir")!.mtime;

    const r1 = call<any>(cb => ops.getattr("/dir", cb));
    const before = Date.now();
    while (Date.now() === before) { /* spin one ms */ }
    const r2 = call<any>(cb => ops.getattr("/dir", cb));

    assert.equal(r1.result.mtime.getTime(), recordedMtime);
    assert.equal(r2.result.mtime.getTime(), recordedMtime);
  });

  test("symlink mtime tracks the node", () => {
    const vfs = new Vfs();
    vfs.symlink("/workspace/link", "target.txt");
    const ops = makeFuseOps(vfs, MOUNT);

    const recordedMtime = vfs.get("/workspace/link")!.mtime;
    const r = call<any>(cb => ops.getattr("/link", cb));
    assert.equal(r.result.mtime.getTime(), recordedMtime);
  });
});
