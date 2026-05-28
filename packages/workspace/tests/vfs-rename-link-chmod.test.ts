/**
 * : rename / link / chmod must produce dirty records that
 * faithfully drive the DO-side sync.
 *
 * After (monotonic rev counter), chmod and link already
 * stamp a fresh rev on the affected node, so the next pull surfaces
 * them. rename also stamps the new paths \u2014 but the *old* paths just
 * vanish from `vfs.nodes`, leaving no tombstone for the DO to act on.
 * This ticket adds the missing tombstones for rename.
 *
 * Symlinks are intentionally out of scope: the wire format
 * (`VfsChange.type: "file" | "dir"`) doesn't yet carry them, and
 * the DO-side Vfs schema doesn't model them either.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vfs } from "../src/container-sandbox/vfs.ts";
import { computeBulkPull } from "../src/container-sandbox/pull.ts";

const BUF = (s: string) => Buffer.from(s, "utf8");

function pickPaths(out: ReturnType<typeof computeBulkPull>, op: "upsert" | "delete"): string[] {
  return out.changes.filter(c => c.op === op).map(c => c.path).sort();
}

describe("rename emits delete tombstones for old paths", () => {
  test("rename of a single file: old path becomes a delete, new path an upsert", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/old.txt", BUF("payload"));
    const sinceRev = vfs.currentRev();

    vfs.rename("/workspace/old.txt", "/workspace/new.txt");
    const out = computeBulkPull(vfs, sinceRev);

    assert.ok(pickPaths(out, "delete").includes("/workspace/old.txt"),
      "old path must surface as a delete tombstone");
    assert.ok(pickPaths(out, "upsert").includes("/workspace/new.txt"),
      "new path must surface as an upsert");
  });

  test("rename of a subtree: every old path under the source becomes a delete", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.mkdir("/workspace/src");
    vfs.putFile("/workspace/src/a.txt", BUF("a"));
    vfs.putFile("/workspace/src/sub/b.txt", BUF("b"));
    const sinceRev = vfs.currentRev();

    vfs.rename("/workspace/src", "/workspace/dst");
    const out = computeBulkPull(vfs, sinceRev);

    const deletes = pickPaths(out, "delete");
    // Every old path \u2014 directory and files \u2014 must appear as a delete.
    assert.ok(deletes.includes("/workspace/src"),         `missing /workspace/src in ${JSON.stringify(deletes)}`);
    assert.ok(deletes.includes("/workspace/src/a.txt"),     `missing /workspace/src/a.txt`);
    assert.ok(deletes.includes("/workspace/src/sub"),       `missing /workspace/src/sub`);
    assert.ok(deletes.includes("/workspace/src/sub/b.txt"), `missing /workspace/src/sub/b.txt`);
    const upserts = pickPaths(out, "upsert");
    assert.ok(upserts.includes("/workspace/dst"));
    assert.ok(upserts.includes("/workspace/dst/a.txt"));
    assert.ok(upserts.includes("/workspace/dst/sub/b.txt"));
  });

  test("rename tombstones use a monotonically-greater rev than the pre-rename watermark", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/old.txt", BUF("payload"));
    const sinceRev = vfs.currentRev();
    vfs.rename("/workspace/old.txt", "/workspace/new.txt");
    // A second pull with the new watermark sees nothing.
    const first  = computeBulkPull(vfs, sinceRev);
    const second = computeBulkPull(vfs, first.maxRev);
    assert.equal(second.changes.length, 0);
  });

  test("rename suppresses tombstones while applying remote changes", () => {
    // Remote pushed the rename; we apply it locally. The tombstone
    // must not echo back on the next outbound pull.
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/old.txt", BUF("payload"));
    const sinceRev = vfs.currentRev();

    vfs.applying = true;
    try {
      vfs.rename("/workspace/old.txt", "/workspace/new.txt");
    } finally {
      vfs.applying = false;
    }

    const out = computeBulkPull(vfs, sinceRev);
    assert.equal(out.changes.length, 0,
      "applying-mode rename must not produce outbound dirty records");
  });
});

describe("chmod and link surface on pull", () => {
  test("chmod stamps a fresh rev and shows up as an upsert", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/a.txt", BUF("x"), 0o100644);
    const sinceRev = vfs.currentRev();

    vfs.chmod("/workspace/a.txt", 0o100755);
    const out = computeBulkPull(vfs, sinceRev);
    const upserts = out.changes.filter(c => c.op === "upsert");
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].path, "/workspace/a.txt");
    assert.equal(upserts[0].mode, 0o100755);
  });

  test("link surfaces the destination path on pull", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspace");
    vfs.putFile("/workspace/src.txt", BUF("shared"));
    const sinceRev = vfs.currentRev();

    vfs.link("/workspace/src.txt", "/workspace/dst.txt");
    const out = computeBulkPull(vfs, sinceRev);
    const upserts = out.changes.filter(c => c.op === "upsert" && c.type === "file");
    assert.ok(upserts.some(c => c.path === "/workspace/dst.txt"),
      "link destination must show up as an upsert");
  });
});
