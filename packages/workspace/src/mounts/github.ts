/**
 * GitHub-backed mount (eager strategy).
 *
 * Flow on first index:
 *
 *   1. Import the GitHub repo into a baseline Cloudflare Artifacts repo
 *      (idempotent, shared across sessions for the same `(owner,repo,ref)`).
 *   2. `git.clone` from the Artifacts remote into the mount's subtree via
 *      a Vfs-backed fs adapter. The full working tree, including `.git/`,
 *      lands in the VFS.
 *   3. If `prefix` is set, lift the prefixed subtree to the mount root
 *      and discard the rest (cheap VFS-internal copy + delete; no network).
 *
 * Once materialize() returns, the workspace marks the mount as indexed
 * and persists the flag in `_workspace_mounts`. DO restarts skip the
 * clone entirely — `.git/` and the working tree are already in SQLite.
 *
 * Write semantics: v1 is read-write *into the VFS only*. The mount
 * accepts `put`/`delete` so the workspace's existing write paths work,
 * but nothing is pushed to GitHub or Artifacts. The `.git/` directory
 * lying around in the VFS sets the table for a future `gitCommit` /
 * `gitPush` family of tools that will mutate it directly.
 *
 * Safeguards against OOM:
 *   - Default `depth: 1` shallow clone.
 *   - Default `maxBytes: 100 MB` budget enforced by the fs adapter.
 *   - The clone runs in the calling isolate; the hard ceiling is
 *     ~"the packfile must fit in workerd's heap". Plenty for typical
 *     CF repos at depth 1; not enough for a full chromium clone.
 */

import type { EagerMount, MountFactory, MountWriteApi } from "./index.js";
import type { Vfs } from "../vfs.js";
import { cloneIntoVfs, ensureBaselineRepo, type ArtifactsBinding } from "./artifacts.js";

/**
 * Environment shape that the mount pulls bindings out of. Declared as a
 * structural type so consumers don't have to align their `Env` exactly —
 * any object with these two properties works.
 */
export interface GitHubMountEnv {
  Artifacts: ArtifactsBinding;
  /** Optional GitHub PAT, currently unused; reserved for private-repo imports. */
  GITHUB_TOKEN?: string;
}

export interface GitHubRepoOptions {
  /** Worker env carrying the `Artifacts` binding (required). */
  env: GitHubMountEnv;
  /**
   * Subdirectory of the repo to expose at the mount root. Empty / "/" =
   * the whole repo. Leading and trailing slashes are normalized away.
   * When set, `.git/` is *not* materialized (only the subtree is).
   */
  prefix?: string;
  /** Branch / tag / commit. Defaults to "main". */
  ref?: string;
  /** Shallow clone depth. Default 1. */
  depth?: number;
  /**
   * Hard cap on cumulative bytes written during clone. Throws and aborts
   * the mount if exceeded. Default 100 MiB.
   */
  maxBytes?: number;
  /** Access mode. Defaults to `"read-only"`. */
  mode?: "read-only" | "read-write";
  /**
   * The Vfs the mount writes through. Normally supplied automatically by
   * the Workspace, but can be set explicitly when constructing a mount
   * outside a workspace (e.g. tests).
   */
  vfs?: Vfs;
}

/**
 * Build a mount factory for a GitHub repository.
 *
 * @param spec  `"<owner>/<repo>"` — must match the GitHub URL shape.
 * @example
 *   mounts: {
 *     "/workspace/project":       GitHubRepo("cloudflare/agents", { env }),
 *     "/workspace/documentation": GitHubRepo("cloudflare/cloudflare-docs", {
 *       prefix: "/src/content/docs/agents/", env,
 *     }),
 *   }
 */
export function GitHubRepo(spec: string, opts: GitHubRepoOptions): MountFactory {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`GitHubRepo: spec must be "owner/repo", got ${JSON.stringify(spec)}`);
  }
  const owner = spec.slice(0, slash);
  const repo  = spec.slice(slash + 1);
  const ref   = opts.ref ?? "main";
  const depth = opts.depth ?? 1;
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const writable = opts.mode === "read-write";
  const prefix = normalizePrefix(opts.prefix);

  return (ctx) => {
    const mount: EagerMount = {
      kind: "github",
      strategy: "eager",
      writable,

      async materialize(api: MountWriteApi): Promise<void> {
        // ctx.vfs is the Workspace's Vfs; opts.vfs is a test/CLI override.
        const vfs = opts.vfs ?? ctx.vfs;
        if (!vfs) {
          throw new Error("GitHubRepo: ctx.vfs missing; this mount must run inside a Workspace");
        }

        // 1. Import into the baseline Artifacts repo (idempotent).
        const baseline = await ensureBaselineRepo({
          artifacts: opts.env.Artifacts,
          owner, repo, ref, depth,
        });

        // 2. Clone. If no prefix, clone directly to the mount root.
        //    With a prefix, clone to a staging dir under the root, then
        //    lift the prefixed subtree up and discard the staging dir.
        const stagingRoot = prefix ? `${ctx.root}/.gh-clone` : ctx.root;
        api.mkdir(stagingRoot);

        await cloneIntoVfs({
          vfs,
          dir: stagingRoot,
          remote: baseline.remote,
          token: baseline.token,
          ref,
          depth,
          maxBytes,
        });

        // 3. Prefix lift (only when configured).
        if (prefix) {
          const src = `${stagingRoot}/${prefix}`;
          const srcStat = vfs.stat(src);
          if (!srcStat || srcStat.type !== "dir") {
            // Roll back so the workspace's `indexed` flag doesn't stick.
            vfs.deleteFile(stagingRoot);
            throw new Error(`GitHubRepo: prefix "${prefix}" not found in ${spec}@${ref}`);
          }
          liftSubtree(vfs, src, ctx.root);
          vfs.deleteFile(stagingRoot);
        }
      },
    };

    if (writable) {
      // v1: writes land in the VFS only. The Workspace mirrors writes to
      // the mount via these hooks, so they need to exist and resolve, but
      // there is no remote side-effect.
      mount.put = async () => { /* no-op in v1 */ };
      mount.delete = async () => { /* no-op in v1 */ };
    }

    return mount;
  };
}

function normalizePrefix(p: string | undefined): string {
  if (!p) return "";
  let out = p;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/"))   out = out.slice(0, -1);
  return out;
}

/**
 * Move every file/dir under `src/` to `dest/`, preserving relative paths.
 * `src` and `dest` must both be absolute VFS paths; `dest` is created if
 * it doesn't already exist.
 *
 * This uses the raw Vfs so the byte budget enforced by `cloneIntoVfs`
 * doesn't apply a second time to bytes that are already in SQLite.
 */
function liftSubtree(vfs: Vfs, src: string, dest: string): void {
  if (!vfs.stat(dest)) vfs.mkdir(dest, 0o40755, dest);
  const files = vfs.listFilesUnder(src);
  for (const f of files) {
    const rel = f.slice(src.length + 1);
    const target = `${dest}/${rel}`;
    const bytes = vfs.readFile(f);
    if (bytes) vfs.writeFile(target, bytes, 0o100644, dest);
  }
}
