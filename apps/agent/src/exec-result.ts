/**
 * Pure helpers for shaping exec tool output.
 *
 * Both the parent Agent and delegated sub-agents route through the same
 * Workspace shell, but the command may target either the cheap worker-backed
 * `shell` backend or the full Linux `container` backend. Keep that routing
 * visible in a structured metadata envelope so the UI can show where a git /
 * npm / build command actually ran, while preserving the legacy top-level
 * fields the model already sees.
 */

export type ExecBackend = "shell" | "container";

export type ExecCommandKind = "git" | "assets" | "artifact" | "shell";

export interface RawExecResultLike {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
  pushed?: number;
  pulled?: number;
  synced?: boolean;
}

export interface ExecToolContext {
  command: string;
  cwd?: string;
  requestedBackend?: ExecBackend;
  resolvedBackend: ExecBackend;
}

export interface ExecToolMetadata {
  kind: "exec";
  backend: ExecBackend;
  requestedBackend: ExecBackend | null;
  cwd: string | null;
  commandKind: ExecCommandKind;
}

export interface ExecToolOutput {
  [key: string]: unknown;
  command: string;
  cwd: string | null;
  /** Legacy location for existing prompts/UI; prefer metadata.backend. */
  backend: ExecBackend;
  metadata: ExecToolMetadata;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutEmpty: boolean;
  stderrEmpty: boolean;
  pushed?: number;
  pulled?: number;
  synced?: boolean;
}

export interface ExecToolErrorOutput {
  [key: string]: unknown;
  command: string;
  cwd: string | null;
  /** Legacy location for existing prompts/UI; prefer metadata.backend. */
  backend: ExecBackend;
  metadata: ExecToolMetadata;
  error: { details: string };
}

export function buildExecToolOutput(ctx: ExecToolContext, result: RawExecResultLike): ExecToolOutput {
  const stdout = truncateExecStream(normalizeExecStream(result.stdout));
  const stderr = truncateExecStream(normalizeExecStream(result.stderr));
  return {
    ...baseExecToolFields(ctx),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
    stdout,
    stderr,
    stdoutEmpty: stdout.length === 0,
    stderrEmpty: stderr.length === 0,
    ...optionalNumber("pushed", result.pushed),
    ...optionalNumber("pulled", result.pulled),
    ...(typeof result.synced === "boolean" ? { synced: result.synced } : {}),
  };
}

export function buildExecToolError(ctx: ExecToolContext, err: unknown): ExecToolErrorOutput {
  return {
    ...baseExecToolFields(ctx),
    error: { details: err instanceof Error ? err.message : String(err) },
  };
}

export function detectExecCommandKind(command: string): ExecCommandKind {
  const first = command.trim().match(/^[A-Za-z0-9._-]+/)?.[0] ?? "";
  if (first === "git") return "git";
  if (first === "assets") return "assets";
  if (first === "artifact") return "artifact";
  return "shell";
}

export function normalizeExecStream(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: false }).decode(value);
  if (Array.isArray(value)) return value.map(normalizeExecStream).join("");
  return String(value);
}

/**
 * Soft cap on the bytes echoed back into the model's tool result for exec
 * stdout/stderr. Workspace collects the full output before returning; without
 * this a `git log` or dependency install could spend the entire input window
 * on a single tool reply.
 */
export function truncateExecStream(value: string, maxBytes = 64 * 1024): string {
  if (!value) return value;
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n\n[truncated, ${value.length - maxBytes} more chars]`;
}

function baseExecToolFields(ctx: ExecToolContext) {
  const cwd = ctx.cwd ?? null;
  const metadata: ExecToolMetadata = {
    kind: "exec",
    backend: ctx.resolvedBackend,
    requestedBackend: ctx.requestedBackend ?? null,
    cwd,
    commandKind: detectExecCommandKind(ctx.command),
  };
  return {
    command: ctx.command,
    cwd,
    backend: ctx.resolvedBackend,
    metadata,
  };
}

function optionalNumber<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return typeof value === "number" ? { [key]: value } as Record<K, number> : {};
}
