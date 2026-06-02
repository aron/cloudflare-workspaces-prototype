/**
 * `git_clone` — shallow-clone a public GitHub repository into the
 * agent's workspace via isomorphic-git. No Cloudflare Artifacts, no
 * fork registry, no commit/push.
 *
 * The fs adapter (`WorkspaceGitFs`) enforces a byte budget; the clone
 * aborts with `EFBIG` if the working tree + packfile exceed it. Depth
 * defaults to 1 so the demo stays well under that budget for typical
 * repos.
 *
 * `git.clone` runs entirely inside the Worker isolate. The packfile
 * has to fit in workerd's heap, which is fine for small / medium
 * repos but not for huge monorepos — same trade-off the hackspace
 * `@cloudflare/git-tools` documents.
 */

import { tool } from "ai";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";
import type { WorkspaceLike } from "../fs/stores/workspace.js";
import { WorkspaceGitFs } from "./workspace-fs.js";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_DEPTH = 1;

export interface GitCloneToolOptions {
  workspace: WorkspaceLike;
  /** Default byte budget. Default 100 MiB. */
  maxBytes?: number;
  /** Default clone depth. Default 1 (shallow). */
  defaultDepth?: number;
}

const inputSchema = z.object({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name")
    .describe('GitHub repository as "owner/name", e.g. "cloudflare/agents".'),
  dest: z.string().describe("Absolute workspace path to clone into, e.g. /workspace/repo."),
  ref: z.string().optional().describe('Branch, tag, or commit to clone. Defaults to "main".'),
  depth: z.number().int().min(1).optional().describe("Shallow clone depth. Defaults to 1."),
  maxBytes: z.number().int().min(1).optional().describe("Cap on bytes written during the clone."),
});

export function createGitCloneTool(opts: GitCloneToolOptions) {
  const maxBytesDefault = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const depthDefault = opts.defaultDepth ?? DEFAULT_DEPTH;
  return tool({
    description:
      "Shallow-clone a public GitHub repository into the workspace " +
      "filesystem using isomorphic-git. Returns the resolved HEAD " +
      "commit and total bytes written. Run this once at the start " +
      "of triage so the rest of the tools have files to read.",
    inputSchema,
    execute: async ({ repo, dest, ref, depth, maxBytes }) => {
      const maxBudget = maxBytes ?? maxBytesDefault;
      const fs = new WorkspaceGitFs(opts.workspace, { maxBytes: maxBudget });
      const url = `https://github.com/${repo}`;
      // Wipe any prior clone at the target. Stale `.git` directories
      // from a previous failed call cause isomorphic-git to error out
      // with "commit ... not available locally" — the second clone
      // refuses to overwrite the orphaned refs.
      try {
        await opts.workspace.fs.rm(dest, { recursive: true, force: true });
      } catch {
        // Best-effort. If rm isn't supported, isomorphic-git may still
        // succeed against an empty dir.
      }
      await opts.workspace.fs.mkdir(dest, { recursive: true });
      await git.clone({
        fs,
        http,
        dir: dest,
        url,
        ref,
        singleBranch: true,
        depth: depth ?? depthDefault,
      });
      let head: string | undefined;
      try {
        head = await git.resolveRef({ fs, dir: dest, ref: "HEAD" });
      } catch {
        head = undefined;
      }
      return {
        ok: true,
        repo,
        ref: ref ?? "default",
        dest,
        head,
        bytesWritten: fs.bytesWritten,
      };
    },
  });
}
