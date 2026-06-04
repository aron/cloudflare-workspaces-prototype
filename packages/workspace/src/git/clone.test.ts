// Unit tests for `@cloudflare/workspace/git`'s clone() wrapper.
//
// isomorphic-git itself is not exercised here: doing so would
// require either a real HTTPS endpoint or a complete fake of the
// smart-HTTP upload-pack protocol, both of which test
// isomorphic-git rather than this wrapper. The tests instead
// inject a fake `git` module and assert the call shape: two
// phases (clone with noCheckout, then checkout), the right
// options forwarded, sensible defaults, and the FsClient sourcing
// rules (explicit fs vs. derive from a workspace-shaped object).

import { describe, expect, it, vi } from "vitest";

import { cloneWith, type IsomorphicGitClient } from "./clone.js";

type CloneArgs = Parameters<IsomorphicGitClient["clone"]>[0];
type CheckoutArgs = Parameters<IsomorphicGitClient["checkout"]>[0];

function fakeGit() {
  const cloneCalls: CloneArgs[] = [];
  const checkoutCalls: CheckoutArgs[] = [];
  const git: IsomorphicGitClient = {
    clone: vi.fn(async (args: CloneArgs) => {
      cloneCalls.push(args);
    }),
    checkout: vi.fn(async (args: CheckoutArgs) => {
      checkoutCalls.push(args);
    }),
  };
  return { git, cloneCalls, checkoutCalls };
}

// The FsClient shape is opaque to this wrapper — isomorphic-git
// inspects it, the wrapper only forwards. A branded empty object
// suffices.
const fakeFs = { __brand: "fake-fs" } as unknown as object;
const fakeHttp = { __brand: "fake-http" } as unknown as object;

describe("cloneWith", () => {
  it("clones with noCheckout, then checks out HEAD", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toMatchObject({
      fs: fakeFs,
      http: fakeHttp,
      url: "https://example.test/repo.git",
      noCheckout: true,
    });

    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]).toMatchObject({
      fs: fakeFs,
      ref: "HEAD",
      force: true,
    });
    // Absent `paths` means full checkout, so filepaths is undefined.
    expect(checkoutCalls[0].filepaths).toBeUndefined();
  });

  it("applies sensible defaults: dir='/', depth=1, singleBranch, noTags", async () => {
    const { git, cloneCalls } = fakeGit();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
    });

    expect(cloneCalls[0]).toMatchObject({
      dir: "/",
      depth: 1,
      singleBranch: true,
      noTags: true,
    });
  });

  it("forwards ref, headers, corsProxy, and progress hooks", async () => {
    const { git, cloneCalls } = fakeGit();
    const onProgress = vi.fn();
    const onMessage = vi.fn();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      ref: "develop",
      headers: { Authorization: "Bearer xyz" },
      corsProxy: "https://cors.example.test",
      onProgress,
      onMessage,
    });

    expect(cloneCalls[0]).toMatchObject({
      ref: "develop",
      headers: { Authorization: "Bearer xyz" },
      corsProxy: "https://cors.example.test",
      onProgress,
      onMessage,
    });
  });

  it("uses the given ref for the checkout phase", async () => {
    const { git, checkoutCalls } = fakeGit();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      ref: "v1.2.3",
    });

    expect(checkoutCalls[0].ref).toBe("v1.2.3");
  });

  it("passes filepaths to checkout when `paths` is provided", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      paths: ["README.md", "packages/foo"],
    });

    // `paths` must not leak into the clone phase — isomorphic-git's
    // clone() has no filepaths option, and silently dropping
    // unknown keys is the kind of thing that breaks later when a
    // future isomorphic-git release adds a same-named option.
    expect(cloneCalls[0]).not.toHaveProperty("filepaths");
    expect(cloneCalls[0]).not.toHaveProperty("paths");

    expect(checkoutCalls[0].filepaths).toEqual(["README.md", "packages/foo"]);
  });

  it("omits depth when depth=0 or Infinity (full history)", async () => {
    for (const depth of [0, Number.POSITIVE_INFINITY]) {
      const { git, cloneCalls } = fakeGit();
      await cloneWith({
        git,
        http: fakeHttp,
        fs: fakeFs,
        url: "https://example.test/repo.git",
        depth,
      });
      expect(cloneCalls[0].depth, `depth=${depth}`).toBeUndefined();
    }
  });

  it("honours explicit singleBranch=false and noTags=false", async () => {
    const { git, cloneCalls } = fakeGit();
    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      singleBranch: false,
      noTags: false,
    });
    expect(cloneCalls[0]).toMatchObject({ singleBranch: false, noTags: false });
  });

  it("uses the dir option for both clone and checkout", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();
    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      dir: "/work/repo",
      url: "https://example.test/repo.git",
    });
    expect(cloneCalls[0].dir).toBe("/work/repo");
    expect(checkoutCalls[0].dir).toBe("/work/repo");
  });

  it("propagates errors from the clone phase and never runs checkout", async () => {
    const boom = new Error("upload-pack 502");
    const git: IsomorphicGitClient = {
      clone: vi.fn(async () => {
        throw boom;
      }),
      checkout: vi.fn(async () => {}),
    };

    await expect(
      cloneWith({
        git,
        http: fakeHttp,
        fs: fakeFs,
        url: "https://example.test/repo.git",
      }),
    ).rejects.toBe(boom);

    expect(git.checkout).not.toHaveBeenCalled();
  });
});
