/**
 * `git_clone` — shallow-clone a public GitHub repository into the
 * agent's workspace via isomorphic-git. No Cloudflare Artifacts, no
 * fork registry, no commit/push.
 *
 * Storage:
 *   The clone is written through a `@platformatic/vfs`
 *   `VirtualFileSystem` over `Workspace.provider()` — the same
 *   `node:fs`-shaped surface wsd uses internally for its FUSE mount.
 *   isomorphic-git accepts that VFS directly as its `fs` argument
 *   because `vfs.promises` already implements the `PromiseFsClient`
 *   contract (including `symlink` / `readlink`, which the dofs
 *   provider implements for real). No bespoke adapter required.
 *
 * Limits:
 *   `git.clone` runs entirely inside the Worker isolate; the packfile
 *   has to fit in workerd's heap, which is fine for small/medium
 *   repos at `depth: 1` (the default) but not for huge monorepos.
 *   Same trade-off the hackspace `@cloudflare/git-tools` documents.
 */

import type { SQLiteWorkspaceProvider } from "@cloudflare/workspace";
import { tool } from "ai";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";
import { createWorkspaceVfs } from "./vfs.js";

const DEFAULT_DEPTH = 1;

export interface GitCloneToolOptions {
  /** dofs provider over the workspace's local store. */
  provider: SQLiteWorkspaceProvider;
  /** Default clone depth. Default 1 (shallow). */
  defaultDepth?: number;
  /**
   * Shared isomorphic-git cache. Passed into `git.clone` so the
   * packfile parsed during the fetch is reused by later isogit calls
   * (statusMatrix, walk, readBlob) on the same provider. Without
   * sharing, every subsequent call re-parses the pack from scratch —
   * fine for small repos, catastrophic for anything with a real
   * history. Pass the same object you hand to `git.walk` etc.
   */
  cache?: Record<string, unknown>;
}

const inputSchema = z.object({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name")
    .describe('GitHub repository as "owner/name", e.g. "cloudflare/agents".'),
  dest: z.string().describe("Absolute workspace path to clone into, e.g. /workspace/repo."),
  ref: z.string().optional().describe('Branch, tag, or commit to clone. Defaults to "main".'),
  depth: z.number().int().min(1).optional().describe("Shallow clone depth. Defaults to 1."),
});

export function createGitCloneTool(opts: GitCloneToolOptions) {
  const depthDefault = opts.defaultDepth ?? DEFAULT_DEPTH;
  // Build the VFS once per tool instance and reuse it across clone
  // calls — the provider is stable, and `@platformatic/vfs.create` is
  // cheap but not free (it registers handlers on construction).
  const vfs = createWorkspaceVfs(opts.provider);
  return tool({
    description:
      "Shallow-clone a public GitHub repository into the workspace " +
      "filesystem using isomorphic-git. Returns the resolved HEAD " +
      "commit and total bytes written. Run this once at the start " +
      "of triage so the rest of the tools have files to read.",
    inputSchema,
    execute: async ({ repo, dest, ref, depth }) => {
      const url = `https://github.com/${repo}`;
      // Wipe any prior clone at the target. Stale `.git` directories
      // from a previous failed call cause isomorphic-git to error
      // out with "commit ... not available locally" — the second
      // clone refuses to overwrite the orphaned refs.
      try {
        await vfs.promises.rmdir(dest);
      } catch {
        // Best-effort. The dir may not exist yet, or `rmdir` may
        // ENOTEMPTY — both are fine for the next mkdir.
      }
      await vfs.promises.mkdir(dest, { recursive: true });
      await git.clone({
        fs: vfs,
        http,
        dir: dest,
        url,
        ref,
        singleBranch: true,
        depth: depth ?? depthDefault,
        cache: opts.cache,
      });
      let head: string | undefined;
      try {
        head = await git.resolveRef({ fs: vfs, dir: dest, ref: "HEAD" });
      } catch {
        head = undefined;
      }
      return {
        ok: true,
        repo,
        ref: ref ?? "default",
        dest,
        head,
      };
    },
  });
}
