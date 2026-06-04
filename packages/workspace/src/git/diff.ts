// Unified-diff between a git ref (default HEAD) and the working
// tree, the way `git diff HEAD` would, but in pure JS via
// isomorphic-git + the `diff` package.
//
// `diffWith` is the testable core: takes a pre-built
// IsomorphicGitDiffClient, an FsClient, a `createPatch` function,
// and a `readFile` function. The public `diff()` in ./index.ts
// resolves those from dynamic imports of `isomorphic-git` and
// `diff` so both stay optional peer deps.

import type { IsomorphicGitFSClient } from "./adapter.js";

/**
 * Status-matrix row as emitted by isomorphic-git's `statusMatrix`:
 * `[filepath, headStatus, workdirStatus, stageStatus]`.
 *   - 0 = absent
 *   - 1 = same as HEAD
 *   - 2 = differs from HEAD
 *   - 3 = differs from HEAD and stage (rarely meaningful here)
 */
export type StatusRow = [string, number, number, number];

/** Subset of isomorphic-git's API used to compute a working-tree diff. */
export interface IsomorphicGitDiffClient {
  resolveRef(args: { fs: object; dir: string; ref: string }): Promise<string>;
  statusMatrix(args: {
    fs: object;
    dir: string;
    ref?: string;
    cache?: object;
  }): Promise<StatusRow[]>;
  readBlob(args: {
    fs: object;
    dir: string;
    oid: string;
    filepath: string;
    cache?: object;
  }): Promise<{ blob: Uint8Array; oid: string }>;
}

/** Signature compatible with the `diff` package's `createPatch`. */
export type CreatePatchFn = (
  fileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
) => string;

/** Signature compatible with `fs.promises.readFile` (binary mode). */
export type ReadFileFn = (path: string) => Promise<Uint8Array | string>;

export interface GitDiffOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Ref to diff against. Defaults to `HEAD`. */
  ref?: string;
}

/**
 * Dependency-injected form. Used directly by tests and by the
 * public `diff()` wrapper.
 */
export interface DiffWithDeps extends GitDiffOptions {
  git: IsomorphicGitDiffClient;
  fs: IsomorphicGitFSClient | object;
  createPatch: CreatePatchFn;
  readFile: ReadFileFn;
  /**
   * isomorphic-git's pack/index cache. Shared with the surrounding
   * GitClient so the packfile is parsed once across clone, diff,
   * and any other isogit call. See clone.ts's CloneWithDeps.cache.
   */
  cache?: object;
}

export async function diffWith(opts: DiffWithDeps): Promise<string> {
  const dir = opts.dir ?? "/";
  const ref = opts.ref ?? "HEAD";

  let head: string;
  try {
    head = await opts.git.resolveRef({ fs: opts.fs, dir, ref });
  } catch {
    // Ref unresolvable (e.g. workspace never cloned). Empty
    // string is a more useful signal than an exception for the
    // common "diff after maybe-no-op" call site.
    return "";
  }

  // Pass `ref` through so the matrix is computed against the
  // requested commit rather than always HEAD. Without this the
  // `ref` argument would only affect blob reads, leaving the
  // status walk silently skewed.
  const status = await opts.git.statusMatrix({ fs: opts.fs, dir, ref, cache: opts.cache });
  const chunks: string[] = [];
  for (const [filepath, headStatus, workdirStatus] of status) {
    // workdirStatus: 0 absent, 1 == HEAD, 2 differs. Skip
    // unchanged rows up front to avoid the blob/file reads.
    if (workdirStatus === 1) continue;

    const headText =
      headStatus === 1
        ? await readBlobAsText(opts.git, opts.fs, dir, head, filepath, opts.cache)
        : "";
    const workdirText =
      workdirStatus === 2 ? await readWorkdirAsText(opts.readFile, dir, filepath) : "";
    const patch = opts.createPatch(filepath, headText, workdirText, "", "");
    if (patch.trim().length > 0) chunks.push(patch);
  }
  return chunks.join("\n");
}

async function readBlobAsText(
  git: IsomorphicGitDiffClient,
  fs: object,
  dir: string,
  oid: string,
  filepath: string,
  cache: object | undefined,
): Promise<string> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath, cache });
    // Best-effort UTF-8 decode. A real diff tool would skip
    // binaries entirely; for the general case here a noisy diff
    // beats a thrown error.
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(blob);
  } catch {
    return "";
  }
}

async function readWorkdirAsText(
  readFile: ReadFileFn,
  dir: string,
  filepath: string,
): Promise<string> {
  try {
    const data = await readFile(`${dir}/${filepath}`);
    if (typeof data === "string") return data;
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(data);
  } catch {
    return "";
  }
}
