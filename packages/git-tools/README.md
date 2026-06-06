# @cloudflare/git-tools

AI-SDK tools that drive [isomorphic-git](https://isomorphic-git.org/) against
[`@cloudflare/workspace`](https://github.com/cloudflare/workspace)-backed
filesystems.

v1 ships **`git_clone`**. The package was once shaped for the full
family (`gitStatus`, `gitCommit`, `gitPush`, `gitDiff`, `gitLog`,
`gitBranch`) built on Cloudflare Artifacts; that family was retired
when the workspace package was published, since the published
`/git` subexport now owns the isomorphic-git glue directly. If we
reintroduce a write-side tool it'll be a thin wrapper over
`createGitClient(...)`.

## Install

```bash
npm i @cloudflare/git-tools
```

Peer dependencies: `ai@^6`, `@cloudflare/workspace@^0.0.0-alpha.3`.

This package no longer pulls `@platformatic/vfs` or `isomorphic-git`
directly — both are bundled inside `@cloudflare/workspace/git`.

## Usage

The clone runs on the **Sandbox DO side**, not on the AI-SDK caller.
`@cloudflare/workspace/git`'s `createGitClient` needs the live
`Workspace.provider()` (`SQLiteWorkspaceProvider`), and that handle
only exists on the in-DO `Workspace` — the `WorkspaceStub` the agent
holds across DO RPC does not expose it.

So this tool is a thin AI-SDK shim that forwards to a caller-supplied
`cloneOnSandbox` callback. The caller is expected to wire that
callback to an RPC method on its Sandbox DO that builds the git
client locally:

```ts
// In your Agent DO (`tools` factory):
import { createGitCloneTool } from "@cloudflare/git-tools";

const git_clone = createGitCloneTool({
  cloneOnSandbox: async (invocation) => {
    const sandbox = await this.resolveSandboxStub();
    return await sandbox.gitClone(invocation);
  },
});

// In your Sandbox DO:
import { createGitClient } from "@cloudflare/workspace/git";

async gitClone(opts: { repo: string; dest: string; ref?: string; depth: number }) {
  await this.#workspace.ready();
  const git = createGitClient({ ws: this.#workspace });
  const url = `https://github.com/${opts.repo}`;
  await this.#workspace.fs.rm(opts.dest, { recursive: true, force: true });
  await this.#workspace.fs.mkdir(opts.dest, { recursive: true });
  await git.clone({
    url,
    dir: opts.dest,
    ref: opts.ref,
    depth: opts.depth,
    singleBranch: true,
  });
  return { ok: true, repo: opts.repo, ref: opts.ref ?? "default", dest: opts.dest };
}
```

The tool's AI-SDK input schema is:

```ts
{
  repo: "owner/name",     // e.g. "cloudflare/agents"
  dest: "/workspace/foo", // absolute workspace path
  ref?:    "main",        // branch, tag, or commit
  depth?:  1,             // shallow clone depth, default 1
}
```

## How it works

1. **AI-SDK call.** Model invokes `git_clone({ repo, dest, ref, depth })`.
2. **Forward.** The tool calls `cloneOnSandbox(invocation)`. Your
   callback resolves the right Sandbox DO stub and invokes its
   `gitClone` RPC method.
3. **Clone (on the Sandbox DO).** `createGitClient({ ws })` builds an
   isomorphic-git fs client over `Workspace.provider()`, with a
   shared packfile cache. `git.clone(...)` writes the working tree
   directly into the SQLite VFS. The wsd container side sees the
   files through its FUSE mount automatically.
4. **Return.** `{ ok: true, repo, ref, dest }`.

Because the VFS is persistent (SQLite-backed via the Durable Object),
a DO restart does not require re-cloning — the working tree and
`.git/` survive.

## Safeguards

- **Shallow by default** (`depth: 1`).
- **Single branch.** `singleBranch: true` is hard-coded on the Sandbox
  side; the tool surface doesn't expose multi-branch fetches.
- **No push, no commit.** Writes from the VFS do not flow back to
  GitHub or anywhere else.

The hard ceiling is "the packfile must fit in the Sandbox DO's heap"
— fine for typical small/medium repos at depth 1, not enough for
huge monorepos.
