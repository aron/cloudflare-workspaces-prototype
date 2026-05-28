/**
 * : canonical workspace paths.
 *
 * Every path that crosses a public API or RPC boundary must be parsed
 * through `parseWorkspacePath`. The result is a `WorkspacePath` brand
 * \u2014 a string nominally distinguishable from raw strings at the type
 * level, but with a runtime identity check we exercise in these tests.
 *
 * Policy:
 *   - Absolute paths only.
 *   - Must live under `/workspace` (or be exactly `/workspace`).
 *   - No `..` or `.` segments, no empty segments / `//`, no NUL bytes,
 *     no trailing slash (except the root `/workspace`).
 *   - Returned form is canonical: deduplicated slashes, no redundant
 *     trailing slash. (Future: NFC normalization \u2014 not in v1.)
 *
 * All failures throw `WorkspacePathError` carrying a stable `.code`
 * field so callers can distinguish "not absolute" from "escapes root"
 * etc. without string-matching.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkspacePath,
  WorkspacePathError,
  WORKSPACE_ROOT,
} from "../src/path.ts";

/**
 * Capture the error thrown by `fn`. node:assert's `throws()` returns
 * `undefined`, so we can't inspect the error directly; this helper
 * does it for us while still failing the test if nothing throws or
 * the thrown value isn't a WorkspacePathError.
 */
function capture(fn: () => unknown): WorkspacePathError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof WorkspacePathError)) {
      throw new Error(`expected WorkspacePathError, got ${e}`);
    }
    return e;
  }
  throw new Error("expected throw, got success");
}

describe("parseWorkspacePath", () => {
  test("accepts a simple path under /workspace", () => {
    const p = parseWorkspacePath("/workspace/a.txt");
    assert.equal(p, "/workspace/a.txt");
  });

  test("accepts the root /workspace itself", () => {
    assert.equal(parseWorkspacePath("/workspace"), "/workspace");
  });

  test("accepts a deep nested path", () => {
    assert.equal(parseWorkspacePath("/workspace/a/b/c/d.txt"), "/workspace/a/b/c/d.txt");
  });

  test("collapses duplicate slashes", () => {
    assert.equal(parseWorkspacePath("/workspace//a.txt"),       "/workspace/a.txt");
    assert.equal(parseWorkspacePath("/workspace/a///b//c.txt"), "/workspace/a/b/c.txt");
  });

  test("strips a trailing slash on non-root paths", () => {
    assert.equal(parseWorkspacePath("/workspace/dir/"),    "/workspace/dir");
    assert.equal(parseWorkspacePath("/workspace/a/b/c/"),  "/workspace/a/b/c");
  });

  test("normalizes /workspace/ to /workspace", () => {
    assert.equal(parseWorkspacePath("/workspace/"), "/workspace");
  });

  test("WORKSPACE_ROOT is the canonical root", () => {
    assert.equal(WORKSPACE_ROOT, "/workspace");
  });

  // ---- rejection cases ----

  test("rejects relative paths", () => {
    const err = capture(() => parseWorkspacePath("a.txt"));
    assert.equal(err.code, "NOT_ABSOLUTE");
  });

  test("rejects the empty string", () => {
    const err = capture(() => parseWorkspacePath(""));
    assert.equal(err.code, "EMPTY");
  });

  test("rejects paths outside /workspace", () => {
    for (const bad of ["/", "/tmp/x", "/workspac", "/etc/passwd"]) {
      const err = capture(() => parseWorkspacePath(bad));
      assert.equal(err.code, "ESCAPE", `expected ESCAPE for ${bad}, got ${err.code}`);
    }
  });

  test("rejects sibling-prefix escapes like /workspace-evil", () => {
    // The bug 009 pattern at the parser level: /workspace-evil is not
    // the same root as /workspace.
    const err = capture(() => parseWorkspacePath("/workspace-evil/x"));
    assert.equal(err.code, "ESCAPE");
  });

  test("rejects .. segments at every position", () => {
    for (const bad of [
      "/workspace/..",
      "/workspace/../etc",
      "/workspace/a/../b",
      "/workspace/a/b/..",
    ]) {
      const err = capture(() => parseWorkspacePath(bad));
      assert.equal(err.code, "TRAVERSAL", `expected TRAVERSAL for ${bad}, got ${err.code}`);
    }
  });

  test("rejects . segments", () => {
    for (const bad of ["/workspace/.", "/workspace/./a", "/workspace/a/./b"]) {
      const err = capture(() => parseWorkspacePath(bad));
      assert.equal(err.code, "TRAVERSAL", `expected TRAVERSAL for ${bad}, got ${err.code}`);
    }
  });

  test("rejects NUL bytes anywhere in the path", () => {
    for (const bad of ["/workspace/\0", "/workspace/a\0b", "/workspace/a/\0/b"]) {
      const err = capture(() => parseWorkspacePath(bad));
      assert.equal(err.code, "INVALID_CHAR", `expected INVALID_CHAR for ${JSON.stringify(bad)}, got ${err.code}`);
    }
  });

  test("rejects non-string inputs at runtime", () => {
    const err = capture(() => parseWorkspacePath(123 as unknown as string));
    assert.equal(err.code, "NOT_STRING");
  });

  test("WorkspacePathError exposes the offending input", () => {
    try {
      parseWorkspacePath("/workspace/../etc");
      assert.fail("expected throw");
    } catch (e) {
      const err = e as WorkspacePathError;
      assert.equal(err.input, "/workspace/../etc");
      assert.equal(err.code, "TRAVERSAL");
      assert.match(err.message, /traversal|\.\./i);
    }
  });
});
