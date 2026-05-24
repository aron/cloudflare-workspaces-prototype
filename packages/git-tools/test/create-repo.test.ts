/**
 * Smoke tests for `gitCreateRepo`. We don't exercise a real Artifacts
 * binding — just the tool surface:
 *
 *   - happy path returns the created repo's remote + sanitised name
 *   - artifacts errors surface as a non-thrown error envelope
 *   - the description mentions creating a fresh repo so the agent picks it
 *     over gitClone when it wants a blank slate
 */

import { describe, expect, it, vi } from "vitest";
import { createGitCreateRepoTool } from "../src/index.js";
import { fakeWorkspace, makeCreateResult, unusedArtifacts } from "./_fakes.js";

describe("createGitCreateRepoTool", () => {
  it("returns the created repo's remote + sanitised name", async () => {
    const create = vi.fn().mockResolvedValue(makeCreateResult("my-app", "hello"));
    const tool = createGitCreateRepoTool({
      workspace: fakeWorkspace(),
      artifacts: { ...unusedArtifacts(), create },
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      name:        "My App!",
      description: "hello",
    });
    // Input "My App!" sanitises to "my-app", so we expect the tool to have
    // called create() with that name (not the raw input).
    expect(create).toHaveBeenCalledWith("my-app", expect.objectContaining({
      description:      "hello",
      setDefaultBranch: "main",
    }));
    expect(result).toEqual({
      name:          "my-app",
      remote:        "https://fake.artifacts.dev/git/default/my-app.git",
      defaultBranch: "main",
      description:   "hello",
    });
  });

  it("returns an error envelope when artifacts.create rejects", async () => {
    const create = vi.fn().mockRejectedValue(new Error("ALREADY_EXISTS"));
    const tool = createGitCreateRepoTool({
      workspace: fakeWorkspace(),
      artifacts: { ...unusedArtifacts(), create },
    });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      name: "dup",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/create repo failed.*ALREADY_EXISTS/) });
  });

  it("exposes a tool description that mentions creating a new repo", () => {
    const tool = createGitCreateRepoTool({
      workspace: fakeWorkspace(),
      artifacts: { ...unusedArtifacts(), create: vi.fn() },
    });
    expect((tool as unknown as { description: string }).description).toMatch(/Create a new, empty/);
  });
});
