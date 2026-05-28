/**
 * Canonical workspace paths.
 *
 * calls for a shared parser/canonicalizer that runs at every
 * boundary which accepts a path from an untrusted caller (public API,
 * container RPC, WASI runner output, mount adapters). This module is
 * that parser.
 *
 * The output is a branded `WorkspacePath` string. The brand is nominal
 * (TypeScript-only) but the runtime contract is verifiable: a value of
 * type `WorkspacePath` is always equal to `parseWorkspacePath(value)`.
 * That gives downstream code a single place to assume the policy is
 * already enforced.
 *
 * Policy (v1):
 *   - Input must be a string. Non-strings throw NOT_STRING.
 *   - Empty input throws EMPTY.
 *   - Must start with `/` (absolute). Otherwise NOT_ABSOLUTE.
 *   - Must lie under `WORKSPACE_ROOT` (=`/workspace`) or be exactly
 *     `WORKSPACE_ROOT`. Sibling-prefix paths like `/workspace-evil`
 *     are ESCAPE.
 *   - No `.` or `..` segments anywhere. Either is TRAVERSAL. This is
 *     checked after slash collapsing so callers can't smuggle `..`
 *     through `//../`.
 *   - No NUL bytes (`\0`) anywhere. INVALID_CHAR.
 *   - Duplicate slashes are collapsed. Trailing slash is stripped on
 *     non-root paths. (`/workspace/` becomes `/workspace`.)
 *
 * Out of scope for v1, intentionally:
 *   - Unicode NFC normalization. We don't currently see paths with
 *     decomposed/precomposed variants in the wild; defer until a
 *     concrete need.
 * - Length limits. owns workspace quotas, including
 *     per-path length.
 *   - Symlink resolution. We don't store symlinks in the worker-side
 *     VFS today.
 */

/** Canonical workspace root. Everything else must live under this. */
export const WORKSPACE_ROOT = "/workspace";

/** Distinguishes a canonical workspace path from a raw user string. */
declare const workspacePathBrand: unique symbol;
export type WorkspacePath = string & { readonly [workspacePathBrand]: true };

export type WorkspacePathErrorCode =
  | "NOT_STRING"
  | "EMPTY"
  | "NOT_ABSOLUTE"
  | "ESCAPE"
  | "TRAVERSAL"
  | "INVALID_CHAR";

export class WorkspacePathError extends Error {
  readonly code: WorkspacePathErrorCode;
  readonly input: unknown;

  constructor(code: WorkspacePathErrorCode, input: unknown, message: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
    this.input = input;
  }
}

/**
 * Parse `raw` into a canonical `WorkspacePath` or throw
 * `WorkspacePathError`. Idempotent: parsing an already-canonical path
 * returns the same value.
 */
export function parseWorkspacePath(raw: string): WorkspacePath {
  if (typeof raw !== "string") {
    throw new WorkspacePathError("NOT_STRING", raw, `expected string path, got ${typeof raw}`);
  }
  if (raw.length === 0) {
    throw new WorkspacePathError("EMPTY", raw, "path is empty");
  }
  if (raw.includes("\0")) {
    throw new WorkspacePathError("INVALID_CHAR", raw, "path contains NUL byte");
  }
  if (!raw.startsWith("/")) {
    throw new WorkspacePathError("NOT_ABSOLUTE", raw, `path must be absolute: ${raw}`);
  }

  // Collapse runs of '/' and split into segments. Filter() handles
  // both internal duplicates and a leading slash producing a leading
  // empty segment.
  const segments = raw.split("/").filter(s => s.length > 0);

  // `.` and `..` segments are rejected outright (rather than resolved)
  // so that two paths that "would resolve to the same thing" can never
  // differ in canonical form depending on history. This is the same
  // stance Go's path/filepath.Clean takes for security-sensitive use:
  // reject, don't resolve.
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new WorkspacePathError("TRAVERSAL", raw, `path contains traversal segment: ${raw}`);
    }
  }

  const canonical = "/" + segments.join("/");

  // Containment check: canonical must equal WORKSPACE_ROOT or be a
  // proper descendant. Using `+ "/"` on both sides avoids the
  // sibling-prefix bug (/workspace-evil treated as a child of /workspace).
  if (canonical !== WORKSPACE_ROOT &&
      !canonical.startsWith(WORKSPACE_ROOT + "/")) {
    throw new WorkspacePathError("ESCAPE", raw, `path escapes ${WORKSPACE_ROOT}: ${raw}`);
  }

  return canonical as WorkspacePath;
}

/**
 * True iff `value` would parse cleanly. Cheaper than try/catch when
 * the caller wants a boolean.
 */
export function isWorkspacePath(value: unknown): value is WorkspacePath {
  try {
    parseWorkspacePath(value as string);
    return true;
  } catch {
    return false;
  }
}
