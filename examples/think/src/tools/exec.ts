/**
 * `exec` — run a shell command inside the container-backed workspace
 * and return `{ stdout, stderr, exitCode }`. Available in the fix
 * phase only.
 *
 * Borrowed from the hackspace agent's exec tool but stripped of the
 * streaming-UI machinery (`LoopTracker`, `ExecOutputBuffer`,
 * per-tool-call cancellation). This example has no UI to stream
 * into and the loop is short enough that running an exec to
 * completion in one tool round is fine.
 */

import { tool } from "ai";
import { z } from "zod";

/**
 * Minimal subset of `@cloudflare/workspace.Workspace` we depend on:
 * the shell facade exposes `exec(command, { cwd, encoding })` and the
 * returned handle resolves to a `{ exitCode, stdout, stderr }` result.
 */
export interface ExecWorkspaceLike {
  shell: {
    exec(
      command: string,
      options: { cwd?: string; encoding: "utf8" },
    ): Promise<{
      result(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }>;
  };
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  /** Truncate captured stdout/stderr above this many bytes. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB per stream

const inputSchema = z.object({
  command: z.string().describe("Shell command, e.g. 'npm test -- --run' or 'git diff HEAD'."),
  cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
});

export function createExecTool(opts: ExecToolOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return tool({
    description:
      "Run a shell command in the workspace sandbox. Use for builds, " +
      "test runs, typechecks, formatters, and `git` plumbing. Prefer " +
      "the dedicated `read` / `write` / `edit` tools for file ops. " +
      "Long output is truncated to keep tool replies small.",
    inputSchema,
    execute: async ({ command, cwd }) => {
      const handle = await opts.workspace.shell.exec(command, {
        cwd,
        encoding: "utf8",
      });
      const result = await handle.result();
      return {
        command,
        cwd: cwd ?? null,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, maxBytes),
        stderr: truncate(result.stderr, maxBytes),
      };
    },
  });
}

function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  // Approximate bytes via length; UTF-8 worst case overcounts but
  // never undercounts, which is what we want for a soft cap.
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n\n[truncated, ${value.length - maxBytes} more bytes]`;
}
