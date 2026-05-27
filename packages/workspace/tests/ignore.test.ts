/**
 * Tests for the pull-scope ignore matcher (commit 1 — "skip ignored
 * path segments on pull").  The matcher controls which paths the
 * container ships back to the DO after exec().  Default callers pass
 * ["node_modules"] so npm install bytes never cross the wire.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { makeIgnore } from "../src/container-sandbox/ignore.ts";

describe("makeIgnore", () => {
  test("empty list matches nothing", () => {
    const m = makeIgnore();
    assert.equal(m("/workspace/anything"), false);
    assert.equal(m("/workspace/node_modules/foo"), false);
    const m2 = makeIgnore([]);
    assert.equal(m2("/workspace/node_modules/foo"), false);
  });

  test("empty / whitespace segments are dropped", () => {
    const m = makeIgnore(["", ""]);
    assert.equal(m("/workspace/anything"), false);
  });

  test("matches a path that has the segment in the middle", () => {
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/workspace/ws-bench/node_modules/hono/index.js"), true);
  });

  test("matches a path that ends with the segment (no trailing slash)", () => {
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/workspace/ws-bench/node_modules"), true);
  });

  test("does NOT match a path where the segment is a prefix of a longer name", () => {
    // /workspace/node_modules2 must not match the 'node_modules' segment.
    // The matcher's contract is path *segments*, not substrings.
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/workspace/node_modules2"), false);
    assert.equal(m("/workspace/node_modulesXX/file"), false);
  });

  test("does NOT match when the segment shows up inside a filename", () => {
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/workspace/src/about_node_modules.md"), false);
  });

  test("matches at the very root", () => {
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/node_modules"), true);
    assert.equal(m("/node_modules/foo"), true);
  });

  test("multiple segments: any one matching is enough", () => {
    const m = makeIgnore([".git", "node_modules", ".cache"]);
    assert.equal(m("/workspace/proj/.git/HEAD"), true);
    assert.equal(m("/workspace/proj/.cache/x"), true);
    assert.equal(m("/workspace/proj/node_modules/y"), true);
    assert.equal(m("/workspace/proj/src/index.ts"), false);
  });

  test("segment that appears twice in a path is still one match", () => {
    // /a/node_modules/b/node_modules/c — both occurrences should
    // independently confirm the match.  We don't care which one wins,
    // only that the predicate returns true.
    const m = makeIgnore(["node_modules"]);
    assert.equal(m("/a/node_modules/b/node_modules/c"), true);
  });

  test("returns boolean (not truthy / falsy)", () => {
    const m = makeIgnore(["node_modules"]);
    assert.equal(typeof m("/workspace/node_modules"), "boolean");
    assert.equal(typeof m("/workspace/other"), "boolean");
  });
});
