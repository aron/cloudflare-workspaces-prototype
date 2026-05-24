/**
 * `gitCommit` — stage every change in the working tree and produce one
 * commit. Honours `.gitignore`. Returns `{ noChanges: true }` cleanly if
 * there's nothing to commit.
 *
 * Author identity is `"Agent" <agent+<sessionId>@hackspace.local>`. The
 * agent's session is part of the email so commits across sessions are
 * distinguishable on the receiving side.
 */

import { tool } from "ai";
import { z } from "zod";
import { commitWorkingTree } from "@cloudflare/workspace/git";
import type { GitWorkspaceLike } from "../internal/workspace.js";

export interface GitCommitToolOptions {
  workspace: GitWorkspaceLike;
}

const inputSchema = z.object({
  dir: z
    .string()
    .describe("Absolute VFS path of the working tree (the dir gitClone wrote to)."),
  message: z
    .string()
    .min(1)
    .optional()
    .describe("Commit message. Defaults to a timestamped 'agent: snapshot' message."),
});

interface CommitOk {
  head: string;
  filesChanged: { added: number; modified: number; removed: number };
}
type CommitResult = CommitOk | { noChanges: true } | { error: string };

export function createGitCommitTool(opts: GitCommitToolOptions) {
  const sessionId = opts.workspace.sessionId;
  const author = {
    name:  "Agent",
    email: `agent+${sessionId}@hackspace.local`,
  };

  return tool({
    description:
      "Commit the current state of a cloned git working tree to a local commit. Stages every change (additions, modifications, deletions) and produces one commit. Returns { noChanges: true } if the tree is clean.",
    inputSchema,
    execute: async ({ dir, message }): Promise<CommitResult> => {
      try {
        const msg = message ?? `agent: snapshot ${new Date().toISOString()}`;
        const result = await commitWorkingTree({
          vfs: opts.workspace.vfs,
          dir,
          message: msg,
          author,
        });
        if (!result) return { noChanges: true };
        return {
          head: result.head,
          filesChanged: {
            added: result.added,
            modified: result.modified,
            removed: result.removed,
          },
        };
      } catch (err) {
        return { error: `commit failed: ${(err as Error).message}` };
      }
    },
  });
}
