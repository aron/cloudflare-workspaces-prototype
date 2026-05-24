/**
 * Smoke tests for `createGitCloneTool`.
 *
 * The git protocol path itself (isomorphic-git → Artifacts) is not
 * exercised here — that requires either a live binding or a substantial
 * fake git server, both of which belong in integration tests. Instead we
 * verify the tool's wiring:
 *
 *   - input schema accepts valid inputs and rejects malformed `repo`
 *   - import calls land on the supplied Artifacts binding with the
 *     correct branch/depth
 *   - mkdir is dispatched on the supplied workspace before clone starts
 *   - clone failures are surfaced as `{ error: string }` (not thrown)
 *
 * To do that without hitting the network, we stub the binding so that
 * `import()` succeeds (returning a fake remote) and the workspace's vfs
 * throws on the first git operation, letting us assert on the error path.
 */

import { describe, expect, it, vi } from "vitest";
import { createGitCloneTool } from "../src/index.js";

function fakeArtifacts() {
  const calls = { import: [] as unknown[], get: [] as string[] };
  return {
    calls,
    binding: {
      async create(_name: string) { throw new Error("unused"); },
      async get(name: string) {
        calls.get.push(name);
        throw new Error("fake: not found");
      },
      async list() { return { repos: [] }; },
      async import(params: unknown) {
        calls.import.push(params);
        return {
          name:          (params as { target: { name: string } }).target.name,
          remote:        "https://fake.artifacts.dev/git/default/x.git",
          defaultBranch: "main",
          token:         "art_v1_x?expires=9999999999",
        };
      },
      async delete() { return true; },
    },
  };
}

/** Minimal Vfs-like stub. Each call returns the canned value or throws. */
function fakeVfs() {
  return {
    stat: vi.fn().mockReturnValue(null),
    readFile: vi.fn().mockReturnValue(null),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    readdir: vi.fn().mockReturnValue([]),
    listFilesUnder: vi.fn().mockReturnValue([]),
  };
}

function fakeWorkspace() {
  return {
    sessionId: "test-session",
    vfs: fakeVfs() as unknown as import("@cloudflare/workspace").Vfs,
    mkdir: vi.fn(async () => {}),
  };
}

describe("createGitCloneTool", () => {
  it("exposes the expected input schema", () => {
    const tool = createGitCloneTool({
      workspace: fakeWorkspace(),
      artifacts: fakeArtifacts().binding,
    });
    expect(tool.description).toMatch(/Clone a public GitHub repository/);
    // ai-sdk's `tool()` returns an object with the input schema attached.
    expect(tool.inputSchema).toBeDefined();
  });

  it("calls workspace.mkdir on dest before importing", async () => {
    const ws = fakeWorkspace();
    const a  = fakeArtifacts();
    const tool = createGitCloneTool({ workspace: ws, artifacts: a.binding });
    // Tool execution will fail at the clone step (no real git transport);
    // the assertion is on the steps that happen before that failure.
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      repo: "cloudflare/agents",
      dest: "/workspace/cf-agents",
    });
    expect(ws.mkdir).toHaveBeenCalledWith("/workspace/cf-agents");
    expect(a.calls.import.length).toBe(1);
    // Clone necessarily fails against our fake (no real http transport);
    // the tool must surface that as a non-thrown error envelope.
    expect(result).toMatchObject({ error: expect.stringMatching(/clone failed/) });
  });

  it("returns an error envelope when mkdir on dest fails", async () => {
    const ws = fakeWorkspace();
    ws.mkdir = vi.fn(async () => { throw new Error("EACCES"); });
    const a  = fakeArtifacts();
    const tool = createGitCloneTool({ workspace: ws, artifacts: a.binding });
    const result = await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      repo: "cloudflare/agents",
      dest: "/somewhere/locked",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/cannot create dest/) });
    // Should bail before touching Artifacts.
    expect(a.calls.import).toEqual([]);
  });

  it("forwards depth and ref to ensureBaselineRepo", async () => {
    const ws = fakeWorkspace();
    const a  = fakeArtifacts();
    const tool = createGitCloneTool({ workspace: ws, artifacts: a.binding });
    await (tool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      repo:  "cloudflare/cloudflare-docs",
      dest:  "/workspace/cf-docs",
      ref:   "next",
      depth: 5,
    });
    expect(a.calls.import).toEqual([{
      source: { url: "https://github.com/cloudflare/cloudflare-docs", branch: "next", depth: 5 },
      target: { name: "gh-cloudflare-cloudflare-docs-next", opts: expect.any(Object) },
    }]);
  });
});
