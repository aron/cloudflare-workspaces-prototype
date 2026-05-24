/**
 * Smoke tests for the gitListRepos tool. We don't need a real Artifacts
 * binding — a fake `list()` that returns fixed pages is enough to pin
 * down filtering, pagination, and the truncation flag.
 */

import { describe, expect, it } from "vitest";
import type { ArtifactsBinding } from "@cloudflare/workspace/git";
import { createGitListReposTool } from "../src/index.js";

const META = {
  description:   null,
  createdAt:     "2099-01-01T00:00:00Z",
  updatedAt:     "2099-01-01T00:00:00Z",
  lastPushAt:    null,
  source:        null,
  readOnly:      false,
  defaultBranch: "main",
} as const;

interface FakeRepo { id: string; name: string }

/** Build a binding whose `list()` paginates a fixed set of repos at page 2 per call. */
function fakeArtifactsWith(names: string[]): ArtifactsBinding {
  const repos: FakeRepo[] = names.map((name, i) => ({ id: `id-${i}`, name }));
  return {
    async create() { throw new Error("unused"); },
    async get()    { throw new Error("unused"); },
    async import() { throw new Error("unused"); },
    async delete() { return true; },
    async list({ cursor }: { cursor?: string } = {}) {
      // Two-per-page paging so we exercise the cursor loop.
      const PAGE = 2;
      const start = cursor ? parseInt(cursor, 10) : 0;
      const slice = repos.slice(start, start + PAGE).map(r => ({ ...META, ...r }));
      const next  = start + PAGE < repos.length ? String(start + PAGE) : undefined;
      return { repos: slice, total: repos.length, cursor: next };
    },
  };
}

async function run(tool: ReturnType<typeof createGitListReposTool>, input: unknown) {
  return (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);
}

describe("createGitListReposTool", () => {
  it("returns every repo when the namespace is small", async () => {
    const tool = createGitListReposTool({ artifacts: fakeArtifactsWith(["alpha", "beta", "gamma"]) });
    const res  = await run(tool, {}) as { count: number; total: number; truncated: boolean; repos: { name: string }[] };
    expect(res.total).toBe(3);
    expect(res.count).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.repos.map(r => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters by case-insensitive substring", async () => {
    const tool = createGitListReposTool({ artifacts: fakeArtifactsWith(["gh-cf-agents", "scratch", "gh-cf-workers"]) });
    const res  = await run(tool, { nameContains: "GH-" }) as { repos: { name: string }[] };
    expect(res.repos.map(r => r.name)).toEqual(["gh-cf-agents", "gh-cf-workers"]);
  });

  it("respects limit and reports truncation", async () => {
    const tool = createGitListReposTool({ artifacts: fakeArtifactsWith(["a", "b", "c", "d", "e"]) });
    const res  = await run(tool, { limit: 2 }) as { count: number; total: number; truncated: boolean };
    expect(res.count).toBe(2);
    expect(res.total).toBe(5);
    expect(res.truncated).toBe(true);
  });

  it("surfaces a clean error envelope when list() throws", async () => {
    const binding: ArtifactsBinding = {
      async create() { throw new Error("unused"); },
      async get()    { throw new Error("unused"); },
      async import() { throw new Error("unused"); },
      async delete() { return true; },
      async list()   { throw new Error("boom"); },
    };
    const tool = createGitListReposTool({ artifacts: binding });
    const res  = await run(tool, {});
    expect(res).toMatchObject({ error: expect.stringMatching(/list repos failed.*boom/) });
  });

  it("exposes a description that mentions checking before creating", async () => {
    const tool = createGitListReposTool({ artifacts: fakeArtifactsWith([]) });
    expect((tool as unknown as { description: string }).description).toMatch(/already/);
  });
});
