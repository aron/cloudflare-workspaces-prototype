// Tests for the public `clone()` / `diff()` dispatchers.
//
// Almost all of what these wrappers do is delegate: resolve an
// FsClient from either `fs` or `workspace`, lazy-load
// isomorphic-git, and call into `cloneWith` / `diffWith`. The
// delegation is covered indirectly by the behaviour tests in
// clone.test.ts and diff.test.ts. The one thing those tests
// don't reach is the input-validation boundary, which this file
// pins down.

import { describe, expect, it, vi } from "vitest";

import { clone, diff } from "./index.js";

describe("public dispatchers", () => {
  it("clone() rejects when neither `fs` nor `workspace` is supplied", async () => {
    await expect(
      clone({
        url: "https://example.test/repo.git",
        // git/http overrides supplied so resolution never reaches
        // the optional-peer-dep loaders; the error must come from
        // the missing FsClient input, not a download attempt.
        git: { clone: vi.fn(), checkout: vi.fn() },
        http: {},
      }),
    ).rejects.toThrow(/fs|workspace/i);
  });

  it("diff() rejects when neither `fs` nor `workspace` is supplied", async () => {
    await expect(
      diff({
        git: {
          resolveRef: vi.fn(async () => "deadbeef"),
          statusMatrix: vi.fn(async () => []),
          readBlob: vi.fn(async () => ({ blob: new Uint8Array(), oid: "deadbeef" })),
        },
        createPatch: vi.fn(),
        readFile: vi.fn(),
      }),
    ).rejects.toThrow(/fs|workspace/i);
  });
});
