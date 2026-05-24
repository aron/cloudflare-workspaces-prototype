/**
 * Structural subset of `@cloudflare/workspace.Workspace` that git tools
 * depend on. Mirrors the pattern used by `@cloudflare/fs-tools` —
 * declaring it here means this package has no hard import dependency on
 * `@cloudflare/workspace`, and tests can swap a mock in trivially.
 */

import type { Vfs } from "@cloudflare/workspace";

export interface GitWorkspaceLike {
  /** Used to scope per-session Artifacts repo names. */
  readonly sessionId: string;
  /** Underlying VFS — passed to the fs adapter for isomorphic-git. */
  readonly vfs: Vfs;
  /** Workspace-level mkdir so the destination root is registered. */
  mkdir(path: string, mode?: number): Promise<void>;
}
