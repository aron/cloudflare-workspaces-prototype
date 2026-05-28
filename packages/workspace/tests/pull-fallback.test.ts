/**
 * `isMissingRpcMethod` is the predicate that decides whether to fall back
 * from `pullDirtyV2` to the legacy `pullDirty` path in
 * `Workspace._pullDirtyAfterLocked`. The legacy fallback exists to handle
 * a deployment skew where a freshly deployed DO is talking to a container
 * image that pre-dates the manifest-aware pull (4fc4d0c). Without the
 * fallback, every container→DO sync silently fails and DO callers see a
 * one-way DO→container view of the workspace.
 *
 * capnweb propagates a missing method on the peer's bootstrap stub as a
 * plain `TypeError` whose message is `'<method>' is not a function.` (with
 * the trailing period). The predicate has to be tight enough that genuine
 * RPC failures still propagate — anything that isn't a TypeError, and any
 * TypeError that doesn't name *this* method, should be rejected.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isMissingRpcMethod } from "../src/workspace.ts";

describe("isMissingRpcMethod", () => {
  test("matches capnweb's missing-method TypeError for the target method", () => {
    const err = new TypeError("'pullDirtyV2' is not a function.");
    assert.equal(isMissingRpcMethod(err, "pullDirtyV2"), true);
  });

  test("rejects a TypeError that names a different method", () => {
    // A different missing method on the same container — the fallback for
    // pullDirtyV2 should not swallow a missing-getBlobs error, since that
    // means the container is in an incoherent state that the caller needs
    // to see.
    const err = new TypeError("'getBlobs' is not a function.");
    assert.equal(isMissingRpcMethod(err, "pullDirtyV2"), false);
  });

  test("rejects non-TypeError errors with the same message shape", () => {
    // A regular Error with the same text isn't capnweb's signal — anything
    // throwing that string from inside the RPC handler is a different bug.
    const err = new Error("'pullDirtyV2' is not a function.");
    assert.equal(isMissingRpcMethod(err, "pullDirtyV2"), false);
  });

  test("rejects unrelated TypeErrors", () => {
    const err = new TypeError("Cannot read properties of undefined");
    assert.equal(isMissingRpcMethod(err, "pullDirtyV2"), false);
  });

  test("rejects non-Error throws", () => {
    assert.equal(isMissingRpcMethod("'pullDirtyV2' is not a function.", "pullDirtyV2"), false);
    assert.equal(isMissingRpcMethod(undefined, "pullDirtyV2"), false);
    assert.equal(isMissingRpcMethod(null, "pullDirtyV2"), false);
  });
});
