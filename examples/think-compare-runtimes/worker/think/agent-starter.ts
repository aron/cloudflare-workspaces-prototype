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
  onAgentError?: (runtime: RuntimeId, error: unknown) => void | Promise<void>;
}

export async function startRuntimeThinkAgents({
  runId,
  fixture,
  workspaceAgent,
  sandboxAgent,
  onAgentError,
}: StartRuntimeThinkAgentsOptions): Promise<void> {
  const results = await Promise.allSettled([
    workspaceAgent.runComparison({ runId, fixture }),
    sandboxAgent.runComparison({ runId, fixture }),
  ]);
  const runtimes: RuntimeId[] = ["workspace", "sandbox"];

  await Promise.all(
    results.map((result, index) => {
      if (result.status === "fulfilled") return undefined;
      return onAgentError?.(runtimes[index] ?? "workspace", result.reason);
    }),
  );
}
