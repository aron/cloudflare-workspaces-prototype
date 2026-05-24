/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
/**
 * Tests for the GitHub→Artifacts→isomorphic-git seam exposed at
 * `@cloudflare/workspace/git`.
 *
 * We exercise:
 *   - `tokenSecret` strips the `?expires=` suffix per the Artifacts docs
 *   - `sanitizeForRepoName` produces names that match the Artifacts
 *     naming rules (start with alnum, then [A-Za-z0-9._-])
 *   - `baselineName` is deterministic and sanitized
 *   - `ensureBaselineRepo` calls `get()` first (fast path) and only falls
 *     through to `import()` on miss
 *   - `ensureBaselineRepo` recovers from an `import()` race by re-reading
 *     via `get()`
 *
 * The actual `git.clone` path is exercised by integration tests against a
 * live Artifacts binding (`remote: true` in wrangler) — not here.
 */

import { describe, expect, it } from "vitest";
import {
  baselineName,
  ensureBaselineRepo,
  sanitizeForRepoName,
  tokenSecret,
  type ArtifactsBinding,
  type ArtifactsRepoHandle,
} from "@cloudflare/workspace/git";

interface FakeRepoState {
  remote: string;
  defaultBranch: string;
}

/** Build a fake Artifacts binding around an in-memory repo registry. */
function fakeArtifacts(initial: Record<string, FakeRepoState> = {}) {
  const repos = new Map<string, FakeRepoState>(Object.entries(initial));
  const calls = {
    get:    [] as string[],
    import: [] as Array<{ url: string; branch?: string; depth?: number; name: string }>,
    create: [] as string[],
  };
  // Hook to make `import()` fail on the next call (race simulation).
  let failNextImport: string | null = null;

  const binding: ArtifactsBinding = {
    async get(name: string): Promise<ArtifactsRepoHandle> {
      calls.get.push(name);
      const state = repos.get(name);
      if (!state) throw new Error(`fake: repo not found: ${name}`);
      return {
        remote:        state.remote,
        defaultBranch: state.defaultBranch,
        async createToken(scope = "read", _ttl?: number) {
          return {
            plaintext: `art_v1_${name}_${scope}?expires=9999999999`,
            expiresAt: "2099-01-01T00:00:00Z",
          };
        },
        async fork(_name, _opts) {
          throw new Error("fake: fork not implemented");
        },
      };
    },
    async create(name: string) {
      calls.create.push(name);
      const state = { remote: `https://fake.artifacts.dev/git/default/${name}.git`, defaultBranch: "main" };
      repos.set(name, state);
      return { name, remote: state.remote, defaultBranch: state.defaultBranch, token: `art_v1_${name}?expires=9999999999` };
    },
    async list() { return { repos: [...repos.entries()].map(([name]) => ({ name, status: "ready" })) }; },
    async import(params) {
      calls.import.push({ url: params.source.url, branch: params.source.branch, depth: params.source.depth, name: params.target.name });
      if (failNextImport === params.target.name) {
        failNextImport = null;
        // Simulate the race winner having populated the repo just
        // before our import() returned its failure.
        if (!repos.has(params.target.name)) {
          repos.set(params.target.name, {
            remote: `https://fake.artifacts.dev/git/default/${params.target.name}.git`,
            defaultBranch: params.source.branch ?? "main",
          });
        }
        throw new Error("fake: import race");
      }
      const state = { remote: `https://fake.artifacts.dev/git/default/${params.target.name}.git`, defaultBranch: params.source.branch ?? "main" };
      repos.set(params.target.name, state);
      return {
        name: params.target.name,
        remote: state.remote,
        defaultBranch: state.defaultBranch,
        token: `art_v1_${params.target.name}?expires=9999999999`,
      };
    },
    async delete(name: string) { return repos.delete(name); },
  };
  return {
    binding,
    calls: () => ({
      get:    [...calls.get],
      import: [...calls.import],
      create: [...calls.create],
    }),
    failNextImport(name: string) { failNextImport = name; },
    repos,
  };
}

describe("tokenSecret", () => {
  it("strips the ?expires= suffix", () => {
    expect(tokenSecret("art_v1_abcd?expires=1234567890")).toBe("art_v1_abcd");
  });

  it("returns the input unchanged when no suffix is present", () => {
    expect(tokenSecret("art_v1_abcd")).toBe("art_v1_abcd");
  });
});

describe("sanitizeForRepoName", () => {
  it("lowercases and replaces invalid characters with a single dash", () => {
    expect(sanitizeForRepoName("Cloudflare/Agents")).toBe("cloudflare-agents");
  });

  it("collapses runs of separators", () => {
    expect(sanitizeForRepoName("foo  //  bar")).toBe("foo-bar");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeForRepoName("---abc---")).toBe("abc");
  });

  it("prefixes 'x' when the first surviving character is not alnum", () => {
    // A leading dot is allowed by the regex but Artifacts requires the
    // first character to be alnum.
    expect(sanitizeForRepoName(".hidden")).toBe("x.hidden");
  });
});

describe("baselineName", () => {
  it("is deterministic across calls", () => {
    const a = baselineName("cloudflare", "agents", "main");
    const b = baselineName("cloudflare", "agents", "main");
    expect(a).toBe(b);
  });

  it("encodes owner, repo, and ref", () => {
    expect(baselineName("cloudflare", "agents", "main")).toBe("gh-cloudflare-agents-main");
  });
});

describe("ensureBaselineRepo", () => {
  it("uses the fast path when the baseline already exists", async () => {
    const name = baselineName("cf", "agents", "main");
    const a = fakeArtifacts({
      [name]: { remote: "https://fake/git/default/" + name + ".git", defaultBranch: "main" },
    });
    const out = await ensureBaselineRepo({ artifacts: a.binding, owner: "cf", repo: "agents", ref: "main" });
    expect(out.name).toBe(name);
    expect(out.remote).toContain(name);
    expect(a.calls().import).toEqual([]);
    expect(a.calls().get).toEqual([name]);
  });

  it("imports when the baseline is missing", async () => {
    const a = fakeArtifacts();
    const out = await ensureBaselineRepo({ artifacts: a.binding, owner: "cloudflare", repo: "agents", ref: "main", depth: 1 });
    expect(out.name).toBe("gh-cloudflare-agents-main");
    expect(a.calls().import).toEqual([{
      url:    "https://github.com/cloudflare/agents",
      branch: "main",
      depth:  1,
      name:   "gh-cloudflare-agents-main",
    }]);
  });

  it("falls back to get() when import() loses a race", async () => {
    const a = fakeArtifacts();
    const name = "gh-cloudflare-agents-main";
    // Arm a race: the next import() will throw but also populate the
    // repo, mimicking a winning concurrent writer that landed first.
    a.failNextImport(name);
    const out = await ensureBaselineRepo({ artifacts: a.binding, owner: "cloudflare", repo: "agents", ref: "main" });
    expect(out.name).toBe(name);
    expect(out.remote).toContain(name);
    // get() is called twice: first the fast-path probe that misses,
    // then the recovery re-read after import() threw.
    expect(a.calls().get.length).toBe(2);
    expect(a.calls().import.length).toBe(1);
  });
});
