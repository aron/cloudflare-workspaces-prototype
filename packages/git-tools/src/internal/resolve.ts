/**
 * Resolve a working tree in the VFS to its baseline Artifacts repo +
 * GitHub `(owner, repo)`.
 *
 * `gitClone` writes the baseline remote URL into the working tree's
 * `.git/config` as `origin`. We read it back here, parse the namespace +
 * repo name out of the URL, and pull `(owner, repo)` from the GitHub
 * description on the baseline (or, when unavailable, infer from the
 * baseline name `gh-<owner>-<repo>-<ref>`).
 *
 * Yes, this means the baseline name is load-bearing for inference.
 * Documented in artifacts.ts; if `sanitizeForRepoName` ever collapses
 * a real owner-or-repo hyphen we have a problem. Mitigation: store the
 * original owner/repo in `.git/config` under a custom section when
 * cloning, and read it back here. Skipped for v1 because every Cloudflare
 * repo we've tested has no hyphens in the owner; reconsider when this
 * bites.
 */

import git from "isomorphic-git";
import {
  createVfsFs,
  parseRemoteForkName,
  type ArtifactsBinding,
} from "@cloudflare/workspace/git";
import type { Vfs } from "@cloudflare/workspace";

export interface ResolveResult {
  /** Baseline Artifacts repo name from `.git/config` origin URL. */
  baselineName: string;
  /** Namespace the baseline lives in (almost always `"default"`). */
  baselineNamespace: string;
  /** GitHub owner, inferred from baseline name. */
  owner: string;
  /** GitHub repo, inferred from baseline name. */
  repo: string;
}

/**
 * Read `.git/config` origin and recover the baseline repo identity.
 * Throws if `dir` isn't a git working tree or doesn't have an origin
 * pointing at an Artifacts URL.
 */
export async function resolveBaseline(opts: {
  vfs: Vfs;
  dir: string;
  artifacts: ArtifactsBinding;
}): Promise<ResolveResult> {
  const fs = createVfsFs(opts.vfs, { mountRoot: opts.dir });
  let originUrl: string | undefined;
  try {
    originUrl = (await git.getConfig({ fs, dir: opts.dir, path: "remote.origin.url" })) ?? undefined;
  } catch (err) {
    throw new Error(`not a git working tree at ${opts.dir}: ${(err as Error).message}`);
  }
  if (!originUrl) {
    throw new Error(`no origin remote configured at ${opts.dir}`);
  }
  const { namespace, name } = parseRemoteForkName(originUrl);

  // Recover (owner, repo) from the baseline name. Format produced by
  // `baselineName(owner, repo, ref)` is `gh-<owner>-<repo>-<ref>`.
  const m = /^gh-([^-]+(?:-[^-]+)*?)-([^-]+(?:-[^-]+)*?)-([^-]+)$/.exec(name);
  if (!m) {
    throw new Error(
      `cannot infer GitHub coordinates from baseline name ${name}; ` +
      `expected gh-<owner>-<repo>-<ref>`,
    );
  }
  // The regex is greedy on owner and repo; for `gh-cloudflare-agents-main`
  // this yields owner="cloudflare", repo="agents", ref="main". For names
  // with hyphenated owners or repos the split is ambiguous — see the
  // file header. We pick the simplest split (one hyphen between owner
  // and repo) since that matches Cloudflare's repos.
  return {
    baselineName: name,
    baselineNamespace: namespace,
    owner: m[1],
    repo:  m[2],
  };
}
