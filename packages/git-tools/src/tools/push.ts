/**
 * `gitPush` — push the working tree's HEAD to the per-session fork on
 * Cloudflare Artifacts.
 *
 * Creates the fork lazily on first push (stored in the supplied
 * `ForkRegistry`). Subsequent calls reuse the fork and refresh the
 * write token if it's near expiry.
 *
 * The local working tree's origin (which points at the baseline) is
 * left untouched — we push via `url:` directly, no `.git/config`
 * mutation. This keeps `git pull` from the baseline working should the
 * agent want to refresh.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  ensureSessionFork,
  pushToRemote,
  sessionWipBranch,
  type ArtifactsBinding,
} from "@cloudflare/workspace/git";
import { resolveBaseline } from "../internal/resolve.js";
import type { GitWorkspaceLike } from "../internal/workspace.js";

export interface GitPushToolOptions {
  workspace: GitWorkspaceLike;
  artifacts: ArtifactsBinding;
}

const inputSchema = z.object({
  dir: z
    .string()
    .describe("Absolute VFS path of the working tree to push."),
  branch: z
    .string()
    .optional()
    .describe('Remote branch name. Defaults to the per-session wip branch ("wip/agent-<sessionId>").'),
  force: z
    .boolean()
    .optional()
    .describe("Force-push. Default true — wip branches are agent-owned and may be rewritten."),
});

interface PushOk {
  branch: string;
  forkRemote: string;
  forkName: string;
}
type PushResult = PushOk | { error: string };

export function createGitPushTool(opts: GitPushToolOptions) {
  return tool({
    description:
      "Push the current HEAD of a cloned git working tree to its per-session Cloudflare Artifacts fork on a wip branch. The fork is created on first push and reused thereafter.",
    inputSchema,
    execute: async ({ dir, branch, force }): Promise<PushResult> => {
      const registry = opts.workspace.forkRegistry;
      if (!registry) {
        return { error: "workspace has no forkRegistry; cannot push" };
      }
      let resolved;
      try {
        resolved = await resolveBaseline({
          vfs: opts.workspace.vfs,
          dir,
          artifacts: opts.artifacts,
        });
      } catch (err) {
        return { error: `resolve baseline: ${(err as Error).message}` };
      }

      let fork;
      try {
        fork = await ensureSessionFork({
          artifacts:    opts.artifacts,
          baselineName: resolved.baselineName,
          owner:        resolved.owner,
          repo:         resolved.repo,
          sessionId:    opts.workspace.sessionId,
          registry,
          dir,
        });
      } catch (err) {
        return { error: `ensure fork: ${(err as Error).message}` };
      }

      const remoteRef = branch ?? sessionWipBranch(opts.workspace.sessionId);

      try {
        await pushToRemote({
          vfs:        opts.workspace.vfs,
          dir,
          remote:     fork.forkRemote,
          writeToken: fork.writeToken,
          ref:        "HEAD",
          remoteRef,
          force:      force ?? true,
        });
      } catch (err) {
        return { error: `push failed: ${(err as Error).message}` };
      }

      return {
        branch:     remoteRef,
        forkRemote: fork.forkRemote,
        forkName:   fork.forkName,
      };
    },
  });
}
