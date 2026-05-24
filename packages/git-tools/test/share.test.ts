/**
 * Smoke tests for the share/push/commit tool wiring.
 *
 * Like `clone.test.ts`, these don't exercise the real git protocol — that
 * needs either a live Artifacts binding or an in-memory git server. The
 * focus is the surface area:
 *
 *   - the share tool rejects if there's no `forkRegistry` on the workspace
 *   - share/push tools resolve their baseline from `.git/config` via
 *     `resolveBaseline`; missing config produces a clean error envelope
 *   - the suggested commands string includes the fork URL and branch
 */

import { describe, expect, it } from "vitest";
import {
  createGitCommitTool,
  createGitPushTool,
  createGitShareTool,
} from "../src/index.js";
import { fakeWorkspace, unusedArtifacts } from "./_fakes.js";

const fakeArtifacts = unusedArtifacts;

describe("createGitShareTool", () => {
  it("rejects when the workspace has no forkRegistry", async () => {
    const tool = createGitShareTool({
      workspace: fakeWorkspace({ withRegistry: false }),
      artifacts: fakeArtifacts(),
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      dir: "/workspace/x",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/forkRegistry/) });
  });

  it("surfaces a clean error when there's no git working tree at dir", async () => {
    const tool = createGitShareTool({
      workspace: fakeWorkspace({ withRegistry: true }),
      artifacts: fakeArtifacts(),
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      dir: "/workspace/x",
    });
    // Either "resolve baseline" (no .git/config) or "commit failed" depending
    // on which isomorphic-git op fails first. Both are non-thrown error envelopes.
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("exposes a tool with the expected description", () => {
    const tool = createGitShareTool({
      workspace: fakeWorkspace({ withRegistry: true }),
      artifacts: fakeArtifacts(),
    });
    expect((tool as unknown as { description: string }).description).toMatch(/writeable/);
  });
});

describe("createGitPushTool", () => {
  it("rejects when the workspace has no forkRegistry", async () => {
    const tool = createGitPushTool({
      workspace: fakeWorkspace({ withRegistry: false }),
      artifacts: fakeArtifacts(),
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      dir: "/workspace/x",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/forkRegistry/) });
  });
});

describe("createGitCommitTool", () => {
  it("returns a non-thrown error envelope when dir has no .git/", async () => {
    const tool = createGitCommitTool({
      workspace: fakeWorkspace({ withRegistry: false }),
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      dir: "/workspace/x",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/commit failed/) });
  });
});
