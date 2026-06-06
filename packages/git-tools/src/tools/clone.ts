/**
 * `git_clone` — shallow-clone a public GitHub repository into the
 * agent's workspace.
 *
 * The clone itself runs inside the Sandbox DO (where the live
 * `Workspace` lives, exposing `.provider()` for the
 * `@cloudflare/workspace/git` client). This tool is a thin AI-SDK
 * wrapper that calls a `cloneOnSandbox` callback the caller wires
 * up to a Sandbox RPC method (e.g. `Sandbox.gitClone(opts)`).
 *
 * Why the indirection: `createGitClient({ ws })` reads
 * `ws.provider()` (a `SQLiteWorkspaceProvider`), which only exists
 * on the in-DO `Workspace` instance. The `WorkspaceStub` the agent
 * holds across DO RPC does not expose a provider. Keeping the
 * client construction on the Sandbox side avoids round-tripping
 * every `node:fs` syscall isomorphic-git makes through capnweb.
 *
 * Limits inherit from upstream: the packfile must fit in the
 * Sandbox DO's heap, fine for small/medium repos at `depth: 1`
 * (the default) but not for huge monorepos.
 */

import { tool } from "ai";
import { z } from "zod";

const DEFAULT_DEPTH = 1;

/**
 * Result returned by the Sandbox-side handler. Matches what the
 * old tool reported so the model's downstream behaviour doesn't
 * change.
 */
export interface GitCloneResult {
  ok: true;
  repo: string;
  ref: string;
  dest: string;
  head?: string;
}

/** Options the tool hands the Sandbox callback. */
export interface GitCloneInvocation {
  repo: string;
  dest: string;
  ref?: string;
  depth: number;
}

export interface GitCloneToolOptions {
  /**
   * Run the clone against a live `Workspace`. The caller is
   * expected to forward to `Sandbox.gitClone(invocation)` (or
   * equivalent) — the Sandbox DO is where `createGitClient`
   * can actually reach `.provider()`.
   */
  cloneOnSandbox: (invocation: GitCloneInvocation) => Promise<GitCloneResult>;
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
});

export function createGitCloneTool(opts: GitCloneToolOptions) {
  const depthDefault = opts.defaultDepth ?? DEFAULT_DEPTH;
  return tool({
    description:
      "Shallow-clone a public GitHub repository into the workspace " +
      "filesystem using isomorphic-git. Returns the resolved HEAD " +
      "commit. Run this once at the start of triage so the rest of " +
      "the tools have files to read.",
    inputSchema,
    execute: async ({ repo, dest, ref, depth }) => {
      return await opts.cloneOnSandbox({
        repo,
        dest,
        ref,
        depth: depth ?? depthDefault,
      });
    },
  });
}
