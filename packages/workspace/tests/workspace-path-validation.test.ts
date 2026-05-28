/**
 * : Workspace public methods must canonicalize paths before
 * touching the Vfs, so that path traversal and root-escape attempts
 * can never make it into the VFS tree, the chunk store, or the sync
 * push to the container.
 *
 * The Workspace facade is the public boundary callers cross. Anything
 * that accepts a `path: string` argument here must parse it through
 * `parseWorkspacePath` and throw `WorkspacePathError` on bad input
 * instead of writing or reading.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Workspace } from "../src/workspace.ts";
import { WorkspacePathError } from "../src/path.ts";
import { makeShimStorage } from "./sql-shim.ts";

function makeWorkspace() {
  const storage = makeShimStorage();
  return new Workspace({
    storage: storage as unknown as DurableObjectStorage,
    sandbox: {} as DurableObjectNamespace,
    sessionId: "test",
  });
}

const BAD_INPUTS: Array<{ path: string; code: string }> = [
  { path: "a.txt",             code: "NOT_ABSOLUTE" },
  { path: "",                  code: "EMPTY" },
  { path: "/etc/passwd",       code: "ESCAPE" },
  { path: "/workspac/x",       code: "ESCAPE" },
  { path: "/workspace-evil/x", code: "ESCAPE" },
  { path: "/workspace/../etc", code: "TRAVERSAL" },
  { path: "/workspace/a/../b", code: "TRAVERSAL" },
  { path: "/workspace/\0",     code: "INVALID_CHAR" },
];

async function expectReject(p: Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await p;
    throw new Error(`${label}: expected WorkspacePathError but got success`);
  } catch (e) {
    if (!(e instanceof WorkspacePathError)) {
      throw new Error(`${label}: expected WorkspacePathError, got ${e}`);
    }
    assert.equal(e.code, code, `${label}: wrong code`);
  }
}

describe("Workspace API rejects non-canonical paths", () => {
  test("writeFile", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.writeFile(path, new Uint8Array([1])), code, `writeFile ${JSON.stringify(path)}`);
    }
  });

  test("readFile", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.readFile(path), code, `readFile ${JSON.stringify(path)}`);
    }
  });

  test("mkdir", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.mkdir(path), code, `mkdir ${JSON.stringify(path)}`);
    }
  });

  test("deleteFile", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.deleteFile(path), code, `deleteFile ${JSON.stringify(path)}`);
    }
  });

  test("stat", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.stat(path), code, `stat ${JSON.stringify(path)}`);
    }
  });

  test("readdir", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.readdir(path), code, `readdir ${JSON.stringify(path)}`);
    }
  });

  test("listFilesUnder", async () => {
    const ws = makeWorkspace();
    for (const { path, code } of BAD_INPUTS) {
      await expectReject(ws.listFilesUnder(path), code, `listFilesUnder ${JSON.stringify(path)}`);
    }
  });
});

describe("Workspace API canonicalizes acceptable paths", () => {
  test("writeFile collapses duplicate slashes and round-trips through readFile", async () => {
    const ws = makeWorkspace();
    await ws.writeFile("/workspace//collapsed//a.txt", new TextEncoder().encode("ok"));
    // Both spellings must resolve to the same canonical key.
    const a = await ws.readFile("/workspace/collapsed/a.txt");
    const b = await ws.readFile("/workspace//collapsed//a.txt");
    assert.deepEqual(a, new TextEncoder().encode("ok"));
    assert.deepEqual(b, new TextEncoder().encode("ok"));
  });

  test("trailing slash on a directory path is normalized", async () => {
    const ws = makeWorkspace();
    await ws.mkdir("/workspace/dir/");
    // readdir on the same path with and without the trailing slash
    // must return the same result; the VFS only has one canonical row.
    const a = await ws.readdir("/workspace/dir");
    const b = await ws.readdir("/workspace/dir/");
    assert.deepEqual(a, b);
  });
});
