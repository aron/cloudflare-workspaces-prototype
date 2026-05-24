/**
 * `gitCreateRepo` — provision a fresh, empty Cloudflare Artifacts repo.
 *
 * Unlike `gitClone` (which imports an existing GitHub repo into a shared
 * baseline) and `gitShare` (which forks the baseline per session), this tool
 * creates a brand-new repo with no source. Use it when the agent wants to
 * start a project from scratch and then `gitCommit` + `gitPush` into it.
 *
 * The caller-supplied name is sanitised the same way baseline names are, so
 * agents can pass through a friendly slug and still get a valid Artifacts
 * repo name. The returned `name` is the actual stored name (after
 * sanitisation), and `remote` is the URL callers should use as the git
 * remote. The fresh write token is *not* returned — push flows mint their
 * own scoped tokens via the workspace's fork registry.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  sanitizeForRepoName,
  type ArtifactsBinding,
} from "@cloudflare/workspace/git";
import type { GitWorkspaceLike } from "../internal/workspace.js";

export interface GitCreateRepoToolOptions {
  /** Workspace handle. Carried for parity with the other tools; unused today. */
  workspace: GitWorkspaceLike;
  /** Cloudflare Artifacts binding (`env.Artifacts`). */
  artifacts: ArtifactsBinding;
}

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Repo name. Will be sanitised to match Artifacts naming rules (letters/digits/./_/-, lowercased). E.g. "my-app".',
    ),
  description: z
    .string()
    .optional()
    .describe("Optional human-readable description for the repo."),
  defaultBranch: z
    .string()
    .optional()
    .describe('Branch name to mark as default. Defaults to "main".'),
});

interface CreateRepoOk {
  /** Sanitised repo name actually stored on Artifacts. */
  name: string;
  /** Git remote URL the caller can clone/push against. */
  remote: string;
  defaultBranch: string;
  description: string | null;
}

type CreateRepoResult = CreateRepoOk | { error: string };

export function createGitCreateRepoTool(opts: GitCreateRepoToolOptions) {
  return tool({
    description:
      "Create a new, empty Cloudflare Artifacts repo. Returns the git remote URL the agent can use with gitCommit/gitPush to populate it. Use this to start a fresh project; use gitClone to start from an existing GitHub repo.",
    inputSchema,
    execute: async (input): Promise<CreateRepoResult> => {
      const name = sanitizeForRepoName(input.name);
      const defaultBranch = input.defaultBranch ?? "main";
      try {
        const created = await opts.artifacts.create(name, {
          description:      input.description,
          setDefaultBranch: defaultBranch,
        });
        return {
          name:          created.name,
          remote:        created.remote,
          defaultBranch: created.defaultBranch,
          description:   created.description,
        };
      } catch (err) {
        return { error: `create repo failed: ${formatErr(err)}` };
      }
    },
  });
}

/** Same error-unwrapping logic as the other tools. Mirrors `clone.ts`. */
function formatErr(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const inner = (err as AggregateError).errors;
  if (Array.isArray(inner) && inner.length > 0) {
    const parts = inner.map((e, i) => `  [${i}] ${formatErr(e)}`).join("\n");
    return `${err.message}\n${parts}`;
  }
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object") {
    return `${err.message} (data=${JSON.stringify(data)})`;
  }
  return err.message;
}
