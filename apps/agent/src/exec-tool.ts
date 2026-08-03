/**
 * Enhanced `exec` tool.
 *
 * The package's built-in `createExecTool` only sends `command` / `cwd`
 * / `backend` and returns `stdout` / `stderr` / `exitCode`. That is
 * exactly right for the command backends ('shell', 'container'), but
 * the 'javascript' backend also carries structured JSON across the
 * boundary:
 *
 *   - `input`  — an optional JSON value handed to the module's default
 *                export as its argument (`runtime.exec`'s `input`
 *                option). Command backends ignore it.
 *   - `value`  — the module's JSON return value, surfaced from the
 *                execution result. Command backends never set it.
 *
 * This app-owned tool is a thin superset of the built-in: same schema
 * for `command` / `cwd` / `backend`, same UTF-8-safe truncation for
 * stdout / stderr, plus the `input` field and the `value` in the
 * result. It replaces `tools.exec` after `createAITools` runs so the
 * rest of the package's tool surface (read / write / edit / ...) is
 * untouched.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { WorkspaceRuntimeValue } from "@cloudflare/computer";

const DEFAULT_MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();

interface ExecWorkspaceLike {
  runtime: {
    exec(
      command: string,
      options: {
        cwd?: string;
        encoding: "utf8";
        backend?: string;
        input?: WorkspaceRuntimeValue;
      },
    ): Promise<{
      result(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        value?: WorkspaceRuntimeValue;
      }>;
    }>;
  };
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  backends: Record<string, { description: string }>;
  defaultBackend: string;
  /** Backends that accept/return structured JSON (input + value). */
  jsonBackends?: readonly string[];
  maxBytes?: number;
}

/** UTF-8-safe truncation to a byte ceiling (mirrors the package tool). */
function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  const totalBytes = encoder.encode(value).byteLength;
  if (totalBytes <= maxBytes) return value;
  let usedBytes = 0;
  let endOffset = 0;
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength;
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    endOffset += char.length;
  }
  return `${value.slice(0, endOffset)}\n\n[truncated, ${totalBytes - usedBytes} more bytes]`;
}

export function createExecTool(options: ExecToolOptions): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const backendIds = Object.keys(options.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(options.defaultBackend)) {
    throw new Error(
      `createExecTool: defaultBackend ${JSON.stringify(options.defaultBackend)} is not one of ${backendIds
        .map((id) => JSON.stringify(id))
        .join(", ")}`,
    );
  }
  const jsonBackends = options.jsonBackends ?? [];

  const description = [
    "Run a command in the workspace. The workspace exposes multiple backends, each with different capabilities.",
    "Pick the cheapest backend that can do the job; fall back to a heavier one only when the lighter backend can't cover what you need.",
    "",
    "Backends:",
    backendIds.map((id) => `- ${JSON.stringify(id)}: ${options.backends[id].description}`).join("\n"),
    "",
    `Default backend: ${JSON.stringify(options.defaultBackend)}. Try this first for any command you're not sure about.`,
    jsonBackends.length > 0
      ? `For ${jsonBackends.map((id) => JSON.stringify(id)).join(" / ")}, the \`command\` is ES module source: export a default function or value. Pass \`input\` to hand a JSON argument to that function; its JSON return value comes back as \`value\`.`
      : "",
    "Prefer the dedicated read, write, and edit tools for file operations. Long output is truncated to keep tool replies small.",
  ]
    .filter(Boolean)
    .join("\n");

  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        "Which backend to run on. Omit to use the default",
        `(${JSON.stringify(options.defaultBackend)}). Set explicitly when the`,
        "default backend is not capable of running the command.",
      ].join(" "),
    );

  return tool({
    description,
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          "The command to run. A shell command line for command backends, or ES module source for JavaScript backends.",
        ),
      cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
      backend: backendSchema,
      input: z
        .unknown()
        .optional()
        .describe(
          "Optional JSON value passed to a JavaScript module's default export as its argument. Ignored by command backends.",
        ),
    }),
    execute: async ({ command, cwd, backend, input }) => {
      const selectedBackend = backend ?? options.defaultBackend;
      const acceptsJson = jsonBackends.includes(selectedBackend);
      try {
        const handle = await options.workspace.runtime.exec(command, {
          cwd,
          encoding: "utf8",
          backend: selectedBackend,
          ...(acceptsJson && input !== undefined
            ? { input: input as WorkspaceRuntimeValue }
            : {}),
        });
        const result = await handle.result();
        return {
          command,
          cwd: cwd ?? null,
          backend: selectedBackend,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, maxBytes),
          stderr: truncate(result.stderr, maxBytes),
          ...(acceptsJson && result.value !== undefined ? { value: result.value } : {}),
        };
      } catch (err) {
        return {
          command,
          cwd: cwd ?? null,
          backend: selectedBackend,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
