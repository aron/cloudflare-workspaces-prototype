/**
 * `gitShare` — convenience wrapper: commit + push + mint short-lived
 * read-only URL for the user's local clone.
 *
 * One-shot operation the agent calls when it wants to hand the user a
 * snapshot of in-flight work for code review. Returns:
 *
 *   - the fork's wip branch name
 *   - the new HEAD commit
 *   - a summary of files changed
 *   - the share URL (with read token embedded in Basic auth) + expiry
 *   - copy-paste git commands the agent can quote at the user
 *
 * If there are no uncommitted changes and the wip branch is already up
 * to date, we still mint a fresh URL so the user can refresh expired
 * links without forcing a no-op commit.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  commitWorkingTree,
  ensureSessionFork,
  mintShareUrl,
  pushToRemote,
  sessionWipBranch,
  type ArtifactsBinding,
} from "@cloudflare/workspace/git";
import git from "isomorphic-git";
import { createVfsFs } from "@cloudflare/workspace/git";
import { resolveBaseline } from "../internal/resolve.js";
import type { GitWorkspaceLike } from "../internal/workspace.js";

export interface GitShareToolOptions {
  workspace: GitWorkspaceLike;
  artifacts: ArtifactsBinding;
  /** Default share-URL TTL in seconds. 1 hour. Caller can override per call. */
  defaultTtlSeconds?: number;
}

const DEFAULT_TTL = 3600;
const MIN_TTL = 60;
const MAX_TTL = 86_400;

const inputSchema = z.object({
  dir: z
    .string()
    .describe("Absolute VFS path of the working tree to share."),
  message: z
    .string()
    .min(1)
    .optional()
    .describe("Commit message for the snapshot. Defaults to a timestamped 'agent: snapshot' message."),
  branch: z
    .string()
    .optional()
    .describe('Remote branch name. Defaults to "wip/agent-<sessionId>".'),
  ttlSeconds: z
    .number()
    .int()
    .min(MIN_TTL)
    .max(MAX_TTL)
    .optional()
    .describe(`Share URL lifetime in seconds. Default ${DEFAULT_TTL} (1 hour). Min ${MIN_TTL}, max ${MAX_TTL}.`),
});

interface ShareOk {
  branch: string;
  head: string;
  filesChanged: { added: number; modified: number; removed: number };
  /** `true` when the share predates the call (no new commit). */
  reused: boolean;
  share: {
    url: string;
    expiresAt: string;
  };
  suggestedCommands: string;
}
type ShareResult = ShareOk | { error: string };

function suggestedCommands(remoteName: string, url: string, branch: string): string {
  return [
    `git remote add ${remoteName} "${url}"`,
    `git fetch ${remoteName}`,
    `git checkout -b review ${remoteName}/${branch}`,
    "git diff main..review",
  ].join("\n");
}

export function createGitShareTool(opts: GitShareToolOptions) {
  const defaultTtl = opts.defaultTtlSeconds ?? DEFAULT_TTL;
  const sessionId  = opts.workspace.sessionId;
  const author = {
    name:  "Agent",
    email: `agent+${sessionId}@hackspace.local`,
  };

  return tool({
    description:
      "Snapshot the cloned git working tree, push it to a per-session fork on Cloudflare Artifacts, and return a short-lived read-only URL the user can `git remote add` against their local clone for code review. Default URL lifetime is 1 hour.",
    inputSchema,
    execute: async ({ dir, message, branch, ttlSeconds }): Promise<ShareResult> => {
      const registry = opts.workspace.forkRegistry;
      if (!registry) {
        return { error: "workspace has no forkRegistry; cannot share" };
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

      // 1. Stage + commit anything dirty. Empty trees → null result; we
      //    still continue to push + share (the user may just want a fresh
      //    URL on an already-shared tree).
      let commitOut: { head: string; added: number; modified: number; removed: number } | null;
      const commitMessage = message ?? `agent: snapshot ${new Date().toISOString()}`;
      try {
        commitOut = await commitWorkingTree({
          vfs: opts.workspace.vfs,
          dir,
          message: commitMessage,
          author,
        });
      } catch (err) {
        return { error: `commit failed: ${(err as Error).message}` };
      }

      // 2. Resolve HEAD (post-commit if we just committed, otherwise the
      //    existing HEAD) so we can return it.
      let head: string;
      try {
        const fs = createVfsFs(opts.workspace.vfs, { mountRoot: dir });
        head = await git.resolveRef({ fs, dir, ref: "HEAD" });
      } catch (err) {
        return { error: `cannot resolve HEAD: ${(err as Error).message}` };
      }

      // 3. Ensure fork + push.
      const remoteRef = branch ?? sessionWipBranch(sessionId);
      let fork;
      try {
        fork = await ensureSessionFork({
          artifacts:    opts.artifacts,
          baselineName: resolved.baselineName,
          owner:        resolved.owner,
          repo:         resolved.repo,
          sessionId,
          registry,
          dir,
        });
      } catch (err) {
        return { error: `ensure fork: ${(err as Error).message}` };
      }
      try {
        await pushToRemote({
          vfs:        opts.workspace.vfs,
          dir,
          remote:     fork.forkRemote,
          writeToken: fork.writeToken,
          ref:        "HEAD",
          remoteRef,
          force:      true,
        });
      } catch (err) {
        return { error: `push failed: ${(err as Error).message}` };
      }

      // 4. Mint share URL.
      let share;
      try {
        share = await mintShareUrl({
          artifacts:  opts.artifacts,
          forkName:   fork.forkName,
          ttlSeconds: ttlSeconds ?? defaultTtl,
        });
      } catch (err) {
        return { error: `mint share URL: ${(err as Error).message}` };
      }

      return {
        branch: remoteRef,
        head,
        filesChanged: commitOut
          ? { added: commitOut.added, modified: commitOut.modified, removed: commitOut.removed }
          : { added: 0, modified: 0, removed: 0 },
        reused: commitOut === null,
        share: { url: share.url, expiresAt: share.expiresAt },
        suggestedCommands: suggestedCommands("agent", share.url, remoteRef),
      };
    },
  });
}
