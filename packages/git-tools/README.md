# @cloudflare/git-tools

AI-SDK tools that drive [isomorphic-git](https://isomorphic-git.org/) against
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repos.

v1 ships **`gitClone`**. The package is shaped for the full family
(`gitStatus`, `gitCommit`, `gitPush`, `gitDiff`, `gitLog`, `gitBranch`) —
each tool gets one file under `src/tools/`, shared helpers live in
`src/internal/`.

## Install

```bash
npm i @cloudflare/git-tools
```

Peer dependencies: `ai@^6`, `@cloudflare/workspace@^0.1`, `isomorphic-git@^1.38`.

## Wrangler binding

```jsonc
{
  "artifacts": [
    { "binding": "Artifacts", "namespace": "default" }
  ]
}
```

## Usage

```ts
import { createGitCloneTool } from "@cloudflare/git-tools";

const gitClone = createGitCloneTool({
  workspace: {
    sessionId: this.name,
    vfs:       this.workspace.vfs,
    mkdir:     (p) => this.workspace.mkdir(p),
  },
  artifacts: env.Artifacts,
});
```

The tool input is:

```ts
{
  repo: "owner/name",     // e.g. "cloudflare/agents"
  dest: "/workspace/foo", // absolute VFS path
  ref?:    "main",        // branch, tag, or commit
  depth?:  1,             // shallow clone depth
  maxBytes?: 100 * 1024 * 1024,  // budget; aborts with EFBIG if exceeded
}
```

## How it works

1. **Import**. `env.Artifacts.import({ source: { url: "https://github.com/..." } })`
   pulls the GitHub repo into a baseline Artifacts repo (idempotent —
   shared across sessions for the same `(owner, repo, ref)`).
2. **Clone**. `git.clone({ fs: vfsAdapter, http, url, ref, depth })` runs
   from the calling Worker isolate, writing the working tree (including
   `.git/`) into the workspace's `Vfs` directly.
3. **Return**. The tool returns `{ repo, ref, dest, head, bytesWritten }`.

Because the VFS is persistent (SQLite-backed via the Durable Object), a
DO restart does not require re-cloning — the working tree and `.git/`
survive.

## Safeguards

- **Shallow by default** (`depth: 1`).
- **Byte budget** (`maxBytes`, default 100 MiB). Enforced inside the fs
  adapter; mid-clone overflow throws `EFBIG` and the clone aborts.
- **No fork yet.** Writes from the VFS do not push back to GitHub or
  Artifacts in v1. The fork seam is reserved for when `gitPush` lands.

The hard ceiling is "the packfile must fit in workerd's heap" — fine for
typical Cloudflare-scale repos at depth 1, not enough for huge monorepos.
For those, a future v2 will spawn the clone in a Dynamic Worker isolate.
