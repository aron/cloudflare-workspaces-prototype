// Public-surface tests for @cloudflare/workspace/git.
//
// The cloneWith argument-shape assertions live in clone.test.ts.
// This file verifies the bits that only exist on the public
// `clone()` wrapper:
//
//   - acceptance of an `IsomorphicGitClient` override (the same
//     hook the cloneWith unit tests use under the hood),
//   - acceptance of a raw FsClient via `fs`,
//   - acceptance of a workspace-shaped object via `workspace`,
//     with `.provider()` called and the result handed to the
//     adapter hook.
//
// @platformatic/vfs is deliberately not loaded here. That path is
// covered by the adapter's own tests; clone() itself only knows
// "if the caller supplied a workspace, ask the adapter to build
// an fs".

import { describe, expect, it, vi } from "vitest";

import type { IsomorphicGitClient } from "./clone.js";
import { clone } from "./index.js";

function recordingGit(): IsomorphicGitClient & {
  cloneArgs: unknown[];
  checkoutArgs: unknown[];
} {
  const cloneArgs: unknown[] = [];
  const checkoutArgs: unknown[] = [];
  return {
    clone: vi.fn(async (a) => {
      cloneArgs.push(a);
    }),
    checkout: vi.fn(async (a) => {
      checkoutArgs.push(a);
    }),
    cloneArgs,
    checkoutArgs,
  };
}

describe("clone (public)", () => {
  it("uses a caller-supplied fs verbatim", async () => {
    const git = recordingGit();
    const fs = { __brand: "supplied-fs" } as unknown as object;
    const http = { __brand: "supplied-http" } as unknown as object;

    await clone({
      url: "https://example.test/repo.git",
      fs,
      http,
      git,
    });

    expect(git.cloneArgs[0]).toMatchObject({ fs, http });
  });

  it("derives fs from a workspace via the adapter hook", async () => {
    const git = recordingGit();
    const http = { __brand: "supplied-http" } as unknown as object;
    const derivedFs = { __brand: "from-provider" } as unknown as object;

    const provider = { __brand: "provider" } as unknown as object;
    const workspace = { provider: vi.fn(() => provider) };

    await clone({
      url: "https://example.test/repo.git",
      workspace,
      http,
      git,
      // Adapter hook is the seam tests use to avoid loading
      // @platformatic/vfs. Production callers do not pass this.
      adapter: vi.fn(async (p) => {
        expect(p).toBe(provider);
        return derivedFs;
      }),
    });

    expect(workspace.provider).toHaveBeenCalledOnce();
    expect(git.cloneArgs[0]).toMatchObject({ fs: derivedFs });
  });

  it("throws if neither fs nor workspace is supplied", async () => {
    await expect(
      clone({
        url: "https://example.test/repo.git",
        git: recordingGit(),
        http: {},
      } as unknown as Parameters<typeof clone>[0]),
    ).rejects.toThrow(/fs|workspace/i);
  });
});
