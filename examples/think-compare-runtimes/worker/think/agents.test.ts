import { beforeEach, describe, expect, test, vi } from "vitest";

const { getSandbox } = vi.hoisted(() => ({
  getSandbox: vi.fn(),
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

import { type RuntimeThinkAgentEnv, SandboxThinkAgent } from "./agents";

describe("SandboxThinkAgent", () => {
  beforeEach(() => {
    getSandbox.mockReset();
  });

  test("lets the Sandbox SDK read transport from Worker configuration", async () => {
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
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.seed({
      runId: "run-1",
      fixture: {
        root: "/workspace/repo",
        task: "test task",
        files: [{ path: "package.json", contents: "{}\n" }],
      },
    });

    expect(getSandbox).toHaveBeenCalledWith(expect.anything(), "run-1-sandbox-think");
    expect(writes).toEqual(["/workspace/repo/package.json"]);
  });
});

class TestSandboxThinkAgent extends SandboxThinkAgent {
  seed(config: Parameters<SandboxThinkAgent["runComparison"]>[0]) {
    return this.seedRuntime(config);
  }
}
