/**
 * `gitListRepos` — list the repos that already exist on the bound
 * Cloudflare Artifacts namespace.
 *
 * Without this, the agent has no way to discover what it created in a
 * past session and tends to mint a new repo on every run. The tool
 * paginates through `Artifacts.list()` and returns plain-data rows the
 * model can scan to decide whether to clone an existing repo or call
 * `gitCreateRepo` for a fresh one.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ArtifactsBinding } from "@cloudflare/workspace/git";

export interface GitListReposToolOptions {
  artifacts: ArtifactsBinding;
}

/** Hard cap on rows we return per call — keeps tool output bounded. */
const MAX_ROWS = 500;

const inputSchema = z.object({
  nameContains: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring filter applied to repo names. Useful for narrowing to a project family like 'gh-' or '<owner>-'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROWS)
    .optional()
    .describe(`Max repos to return. Default ${MAX_ROWS}, hard-capped at ${MAX_ROWS}.`),
});

interface RepoRow {
  name: string;
  defaultBranch: string;
  description: string | null;
  /** Where the repo was imported from (e.g. a GitHub URL), or null. */
  source: string | null;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent push, or null if never pushed. */
  lastPushAt: string | null;
}

interface ListReposOk {
  count: number;
  /** Total repos in the namespace, before filtering / limiting. */
  total: number;
  /** True if `total` exceeded `limit` and rows were dropped. */
  truncated: boolean;
  repos: RepoRow[];
}
type ListReposResult = ListReposOk | { error: string };

export function createGitListReposTool(opts: GitListReposToolOptions) {
  return tool({
    description:
      "List the git repos already provisioned on this Artifacts namespace. Use this before gitCreateRepo or gitClone to check whether a suitable repo already exists from a past session — avoids minting duplicates. Returns name, defaultBranch, description, source URL (if imported from GitHub), and timestamps.",
    inputSchema,
    execute: async (input): Promise<ListReposResult> => {
      const limit  = input.limit ?? MAX_ROWS;
      const needle = input.nameContains?.toLowerCase();

      const out: RepoRow[] = [];
      let total = 0;
      let cursor: string | undefined;
      try {
        do {
          const page = await opts.artifacts.list({ limit: 200, cursor });
          total = page.total;
          for (const r of page.repos) {
            if (needle && !r.name.toLowerCase().includes(needle)) continue;
            if (out.length >= limit) break;
            out.push({
              name:          r.name,
              defaultBranch: r.defaultBranch,
              description:   r.description,
              source:        r.source,
              readOnly:      r.readOnly,
              createdAt:     r.createdAt,
              updatedAt:     r.updatedAt,
              lastPushAt:    r.lastPushAt,
            });
          }
          if (out.length >= limit) break;
          cursor = page.cursor;
        } while (cursor);
      } catch (err) {
        return { error: `list repos failed: ${formatErr(err)}` };
      }

      return {
        count:     out.length,
        total,
        truncated: out.length < total && out.length >= limit,
        repos:     out,
      };
    },
  });
}

/** Same error-unwrapping logic as the other tools. Mirrors `create-repo.ts`. */
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
