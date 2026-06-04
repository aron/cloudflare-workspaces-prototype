// Behavioural tests for `diffWith` against real isomorphic-git +
// the real `diff` package, backed by an in-memory `memfs` volume.
//
// The mocked seam here is the filesystem — `memfs` is functionally
// node:fs and is the same kind of substitute isomorphic-git's own
// test suite uses. Everything else (status-matrix walk, blob
// reading, patch generation, ref resolution) is real code, so the
// assertions are on observable diff output rather than on which
// arguments the wrapper passed to an injected fake.
//
// Each test builds a tiny repo from scratch in `memfs`, runs
// `diffWith` against it, and checks the unified-diff output.

import { createPatch } from "diff";
import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { diffWith, type IsomorphicGitDiffClient } from "./diff.js";

const DIR = "/repo";
const AUTHOR = { name: "test", email: "test@example.test" };

// isomorphic-git's typings are wider than `IsomorphicGitDiffClient`;
// the cast happens once here so individual tests stay clean.
const isomorphicGit = git as unknown as IsomorphicGitDiffClient;

async function init(): Promise<void> {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function commitFile(path: string, content: string, message: string): Promise<string> {
  await memfs.promises.writeFile(`${DIR}/${path}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: path });
  return git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

async function runDiff(opts: { ref?: string } = {}): Promise<string> {
  return diffWith({
    git: isomorphicGit,
    fs: memfs,
    createPatch,
    readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
    dir: DIR,
    ref: opts.ref,
  });
}

describe("diffWith (real isomorphic-git + memfs)", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("returns '' when HEAD cannot be resolved (no commits yet)", async () => {
    await init();
    expect(await runDiff()).toBe("");
  });

  it("returns '' when the working tree matches HEAD", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    expect(await runDiff()).toBe("");
  });

  it("emits a unified diff for a modified file", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello world\n");

    const out = await runDiff();
    // Real createPatch output: file header + a hunk with the old
    // line removed and the new line added.
    expect(out).toContain("--- a.txt");
    expect(out).toContain("+++ a.txt");
    expect(out).toContain("-hello");
    expect(out).toContain("+hello world");
  });

  it("emits a diff for an added (untracked) file", async () => {
    await init();
    await commitFile("a.txt", "kept\n", "init");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "new\n");

    const out = await runDiff();
    expect(out).toContain("--- b.txt");
    expect(out).toContain("+new");
    // The untouched file must not appear in the diff.
    expect(out).not.toContain("--- a.txt");
  });

  it("emits a diff for a deleted file", async () => {
    await init();
    await commitFile("gone.txt", "bye\n", "init");
    await memfs.promises.unlink(`${DIR}/gone.txt`);

    const out = await runDiff();
    expect(out).toContain("--- gone.txt");
    expect(out).toContain("-bye");
    expect(out).not.toMatch(/^\+bye/m);
  });

  it("joins diffs for multiple changed files", async () => {
    await init();
    await commitFile("a.txt", "alpha\n", "init a");
    await commitFile("b.txt", "beta\n", "init b");

    await memfs.promises.writeFile(`${DIR}/a.txt`, "alpha v2\n");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "beta v2\n");

    const out = await runDiff();
    expect(out).toContain("--- a.txt");
    expect(out).toContain("--- b.txt");
    expect(out).toContain("+alpha v2");
    expect(out).toContain("+beta v2");
  });

  it("forwards the cache to statusMatrix and readBlob", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello world\n");

    const cache = {};
    const statusSpy = vi.spyOn(git, "statusMatrix");
    const blobSpy = vi.spyOn(git, "readBlob");
    try {
      await diffWith({
        git: isomorphicGit,
        fs: memfs,
        createPatch,
        readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
        dir: DIR,
        cache,
      });
      // Both passes the *same* cache reference; isomorphic-git
      // mutates it in place, so identity matters more than shape.
      expect(statusSpy.mock.calls[0][0]).toMatchObject({ cache });
      expect(blobSpy.mock.calls[0][0]).toMatchObject({ cache });
    } finally {
      statusSpy.mockRestore();
      blobSpy.mockRestore();
    }
  });

  it("respects the `ref` argument when diffing against an older commit", async () => {
    await init();
    const first = await commitFile("a.txt", "v1\n", "v1");
    await commitFile("a.txt", "v2\n", "v2"); // HEAD is now at v2.

    // Workdir matches HEAD, but differs from `first`. Diffing against
    // HEAD returns "", diffing against `first` returns the v1->v2
    // delta.
    expect(await runDiff()).toBe("");

    const out = await runDiff({ ref: first });
    expect(out).toContain("-v1");
    expect(out).toContain("+v2");
  });
});
