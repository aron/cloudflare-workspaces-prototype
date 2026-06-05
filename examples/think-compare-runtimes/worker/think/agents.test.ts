import { beforeEach, describe, expect, test, vi } from "vitest";

const { getSandbox, runRealThinkTurn, warmPoolReleases } = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  runRealThinkTurn: vi.fn(),
  warmPoolReleases: [] as string[],
}));

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox,
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: unknown,
    ) {}
  },
}));

vi.mock("@cloudflare/workspace", () => ({
  CloudflareContainerBackend: class {},
  Workspace: class {},
  WorkspaceProxy: class {},
}));

vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
}));

vi.mock("partyserver", () => ({
  getServerByName: vi.fn(),
}));

vi.mock("./real-turn", () => ({
  runRealThinkTurn,
}));

vi.mock("../container-pools", () => ({
  containerSleepAfter: (env: { CONTAINER_SLEEP_AFTER?: string }) =>
    env.CONTAINER_SLEEP_AFTER ?? "2m",
  getWarmPoolHandle: () => ({
    async getContainer() {
      return "sandbox-physical-1";
    },
    async releaseContainer(runId: string) {
      warmPoolReleases.push(runId);
    },
  }),
}));

import { type RuntimeThinkAgentEnv, SandboxThinkAgent } from "./agents";

describe("SandboxThinkAgent", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    runRealThinkTurn.mockReset();
  });

  test("uses the warm-pool assignment for Sandbox file operations", async () => {
    const writes: string[] = [];
    getSandbox.mockReturnValue({
      async mkdir() {},
      async writeFile(path: string) {
        writes.push(path);
      },
    });
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
        CONTAINER_SLEEP_AFTER: "2m",
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.run({
      runId: "run-1",
      fixture: {
        root: "/workspace/repo",
        task: "test task",
        files: [{ path: "package.json", contents: "{}\n" }],
      },
    });

    expect(getSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "sandbox-physical-1",
      expect.objectContaining({ sleepAfter: "2m" }),
    );
    expect(writes).toEqual(["/workspace/repo/package.json"]);
  });

  test("releases Sandbox warm-pool assignments during runtime cleanup", async () => {
    warmPoolReleases.length = 0;
    getSandbox.mockReturnValue({
      async mkdir() {},
      async writeFile() {},
    });
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.run({
      runId: "run-1",
      fixture: { root: "/workspace/repo", task: "", files: [] },
    });

    expect(warmPoolReleases).toEqual(["run-1"]);
  });
});

class TestSandboxThinkAgent extends SandboxThinkAgent {
  run(config: Parameters<SandboxThinkAgent["runComparison"]>[0]) {
    return this.runWithRuntime(config, {} as never);
  }
}
