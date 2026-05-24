/**
 * `gitClone` — AI-SDK tool that clones a public GitHub repository into
 * the workspace's VFS via Cloudflare Artifacts + isomorphic-git.
 *
 * Flow (mirrors `GitHubRepo` mount):
 *   1. Import GitHub repo into a baseline Artifacts repo (idempotent).
 *   2. `git.clone` the baseline remote into `dest` inside the workspace
 *      VFS, with a byte budget guarding against OOM.
 *   3. Return the commit hash + bytes-written so the agent can confirm.
 *
 * The tool does *not* fork per session — writes never push back in v1.
 * If a future tool adds commit/push, switch this to call `repo.fork()`
 * + clone the fork; the rest of the surface is unchanged.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  cloneIntoVfs,
  ensureBaselineRepo,
  type ArtifactsBinding,
} from "@cloudflare/workspace/git";
import type { GitWorkspaceLike } from "../internal/workspace.js";

export interface GitCloneToolOptions {
  /** Workspace handle. Must expose `vfs` + `sessionId` + `mkdir`. */
  workspace: GitWorkspaceLike;
  /** Cloudflare Artifacts binding (`env.Artifacts`). */
  artifacts: ArtifactsBinding;
  /** Default byte budget. Default 100 MiB. */
  maxBytes?: number;
  /** Default clone depth. Default 1 (shallow). */
  defaultDepth?: number;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_DEPTH     = 1;

const inputSchema = z.object({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name")
    .describe('GitHub repository as "owner/name", e.g. "cloudflare/agents".'),
  dest: z
    .string()
    .describe("Absolute VFS path to clone into (e.g. /workspace/cloudflare-agents)."),
  ref: z
    .string()
    .optional()
    .describe('Branch, tag, or commit to clone. Defaults to "main".'),
  depth: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Shallow clone depth. Defaults to 1."),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Cap on bytes written during the clone. Aborts if exceeded."),
});

interface CloneResult {
  repo: string;
  ref: string;
  dest: string;
  /** Resolved commit SHA at HEAD. May be undefined for an empty repo. */
  head?: string;
  /** Total bytes written through the fs adapter. */
  bytesWritten: number;
}

export function createGitCloneTool(opts: GitCloneToolOptions) {
  const maxBytesDefault = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const depthDefault    = opts.defaultDepth ?? DEFAULT_DEPTH;

  return tool({
    description:
      "Clone a public GitHub repository into the workspace VFS. Uses Cloudflare Artifacts as the transport (one-time import per repo+ref) and isomorphic-git for the working tree. Shallow by default; pass `depth` to deepen. Aborts with EFBIG if the working tree exceeds `maxBytes`.",
    inputSchema,
    execute: async (input): Promise<CloneResult | { error: string }> => {
      const slash = input.repo.indexOf("/");
      const owner = input.repo.slice(0, slash);
      const repo  = input.repo.slice(slash + 1);
      const ref   = input.ref ?? "main";
      const depth = input.depth ?? depthDefault;
      const maxBytes = input.maxBytes ?? maxBytesDefault;

      // The dest path must exist as a directory before clone writes into
      // it. Going through Workspace.mkdir keeps any mount-bookkeeping
      // intact (e.g. don't try to clone into a read-only mount root).
      try {
        await opts.workspace.mkdir(input.dest);
      } catch (err) {
        return { error: `cannot create dest ${input.dest}: ${formatErr(err)}` };
      }

      let baseline;
      try {
        baseline = await ensureBaselineRepo({
          artifacts: opts.artifacts,
          owner, repo, ref, depth,
        });
      } catch (err) {
        return { error: `artifacts import failed: ${formatErr(err)}` };
      }

      try {
        const { bytesWritten, head } = await cloneIntoVfs({
          vfs: opts.workspace.vfs,
          dir: input.dest,
          remote: baseline.remote,
          token: baseline.token,
          ref,
          depth,
          maxBytes,
        });
        return {
          repo: input.repo,
          ref,
          dest: input.dest,
          head,
          bytesWritten,
        };
      } catch (err) {
        return { error: `clone failed: ${formatErr(err)}` };
      }
    },
  });
}

/**
 * Render an error for the tool result. Unwraps AggregateError so the inner
 * causes are visible (isomorphic-git's http client throws AggregateError on
 * fetch failure with the per-attempt errors hidden behind `.errors`).
 */
function formatErr(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const inner = (err as AggregateError).errors;
  if (Array.isArray(inner) && inner.length > 0) {
    const parts = inner.map((e, i) => `  [${i}] ${formatErr(e)}`).join("\n");
    return `${err.message}\n${parts}`;
  }
  // isomorphic-git wraps fetch errors with a `.data` payload — surface it.
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object") {
    return `${err.message} (data=${JSON.stringify(data)})`;
  }
  return err.message;
}
