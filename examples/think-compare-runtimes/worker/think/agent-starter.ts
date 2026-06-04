import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";

export interface RuntimeThinkAgentRunInput {
  runId: string;
  fixture: ComparisonFixture;
}

export interface RuntimeThinkAgentHandle {
  runComparison(input: RuntimeThinkAgentRunInput): Promise<void>;
}

export interface StartRuntimeThinkAgentsOptions {
  runId: string;
  fixture: ComparisonFixture;
  workspaceAgent: RuntimeThinkAgentHandle;
  sandboxAgent: RuntimeThinkAgentHandle;
  onAgentStart?: (runtime: RuntimeId) => void | Promise<void>;
  onAgentComplete?: (runtime: RuntimeId) => void | Promise<void>;
  onAgentError?: (runtime: RuntimeId, error: unknown) => void | Promise<void>;
}

export async function startRuntimeThinkAgents({
  runId,
  fixture,
  workspaceAgent,
  sandboxAgent,
  onAgentStart,
  onAgentComplete,
  onAgentError,
}: StartRuntimeThinkAgentsOptions): Promise<void> {
  const agents: Array<{ runtime: RuntimeId; agent: RuntimeThinkAgentHandle }> = [
    { runtime: "workspace", agent: workspaceAgent },
    { runtime: "sandbox", agent: sandboxAgent },
  ];

  await Promise.all(agents.map(({ runtime }) => onAgentStart?.(runtime)));

  const results = await Promise.allSettled(
    agents.map(({ agent }) => agent.runComparison({ runId, fixture })),
  );

  await Promise.all(
    results.map((result, index) => {
      const runtime = agents[index]?.runtime ?? "workspace";
      if (result.status === "fulfilled") return onAgentComplete?.(runtime);
      return onAgentError?.(runtime, result.reason);
    }),
  );
}
