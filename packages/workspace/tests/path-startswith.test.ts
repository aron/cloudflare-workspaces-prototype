/**
 * : pathStartsWith() must distinguish a directory from a
 * sibling that merely shares its name prefix.
 *
 * The bug was that `findFiles("/workspace/foo")` and
 * `grep(pat, "/workspace/foo")` used `path.startsWith(directory)`
 * directly, so `/workspace/foobar` was reported as living under
 * `/workspace/foo`. This test pins down the helper that fixes it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pathStartsWith } from "../src/shared/index.ts";

describe("pathStartsWith", () => {
  test("a path is a descendant of itself", () => {
    assert.equal(pathStartsWith("/workspace/foo", "/workspace/foo"), true);
  });

  test("a path inside the directory is a descendant", () => {
    assert.equal(pathStartsWith("/workspace/foo/bar.txt", "/workspace/foo"), true);
    assert.equal(pathStartsWith("/workspace/foo/sub/deep", "/workspace/foo"), true);
  });

  test("a sibling with a shared name prefix is NOT a descendant", () => {
    assert.equal(pathStartsWith("/workspace/foobar", "/workspace/foo"), false);
    assert.equal(pathStartsWith("/workspace/foobar/x", "/workspace/foo"), false);
  });

  test("trailing-slash variants of the directory are equivalent", () => {
    assert.equal(pathStartsWith("/workspace/foo", "/workspace/foo/"), true);
    assert.equal(pathStartsWith("/workspace/foo/bar", "/workspace/foo/"), true);
    assert.equal(pathStartsWith("/workspace/foobar", "/workspace/foo/"), false);
  });

  test("the root '/' contains everything", () => {
    assert.equal(pathStartsWith("/", "/"), true);
    assert.equal(pathStartsWith("/anything", "/"), true);
    assert.equal(pathStartsWith("/workspace/deep/file", "/"), true);
  });

  test("unrelated paths are not descendants", () => {
    assert.equal(pathStartsWith("/other", "/workspace"), false);
    assert.equal(pathStartsWith("/workspac", "/workspace"), false);
  });
});
