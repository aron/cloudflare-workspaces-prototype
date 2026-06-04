/**
 * `git_clone` — shallow-clone a public GitHub repository into the
 * agent's workspace via `@cloudflare/workspace/git`.
 *
 * Limits:
 *   The clone runs entirely inside the Worker isolate; the packfile
 *   has to fit in workerd's heap, which is fine for small/medium
 *   repos at `depth: 1` (the default) but not for huge monorepos.
 */

import type { Workspace } from "@cloudflare/workspace";
import { createGitClient } from "@cloudflare/workspace/git";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_DEPTH = 1;

export interface GitCloneToolOptions {
  /** Workspace whose store the clone is written into. */
  ws: Workspace;
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
  const git = createGitClient({ ws: opts.ws });
  return tool({
    description:
      "Shallow-clone a public GitHub repository into the workspace " +
      "filesystem using isomorphic-git. Run this once at the start " +
      "of triage so the rest of the tools have files to read.",
    inputSchema,
    execute: async ({ repo, dest, ref, depth }) => {
      const url = `https://github.com/${repo}`;
      // Wipe any prior clone at the target. Stale `.git` directories
      // from a previous failed call cause isomorphic-git to error
      // out with "commit ... not available locally" — the second
      // clone refuses to overwrite the orphaned refs.
      await opts.ws.fs.rm(dest, { recursive: true, force: true });
      await opts.ws.fs.mkdir(dest, { recursive: true });
      await git.clone({
        url,
        dir: dest,
        ref,
        depth: depth ?? depthDefault,
        cache: opts.cache,
      });
      return {
        ok: true,
        repo,
        ref: ref ?? "default",
        dest,
      };
    },
  });
}
