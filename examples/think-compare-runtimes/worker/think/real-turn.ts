import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import type { RuntimeAdapter } from "../runtime/adapter";
import type { RuntimeThinkToolRecorder } from "./runtime-tools";

export interface ThinkTurnInvocation {
  prompt: string;
}

export interface ThinkTurnResult {
  text: string;
}

export interface RealThinkTurnOptions {
  adapter: RuntimeAdapter;
  recorder: RuntimeThinkToolRecorder;
  fixture: ComparisonFixture;
  invoke(input: ThinkTurnInvocation): Promise<ThinkTurnResult>;
}

export async function runRealThinkTurn({
  adapter,
  recorder,
  fixture,
  invoke,
}: RealThinkTurnOptions): Promise<ThinkTurnResult> {
  const runtime = adapter.runtime;
  await recorder.record({
    runtime,
    kind: "agent_message",
    title: "Think turn started",
    detail: `Model-backed Think agent is running against the ${runtimeLabel(runtime)} runtime.`,
  });

  try {
    const result = await invoke({ prompt: createRuntimePrompt(fixture) });
    if (result.text.trim().length === 0) {
      throw new Error("Think turn completed without assistant text.");
    }
    await recorder.record({
      runtime,
      kind: "agent_message",
      title: "Think turn complete",
      detail: result.text,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recorder.record({
      runtime,
      kind: "agent_tool_error",
      title: "Think turn failed",
      detail: message,
    });
    throw error;
  }
}

export function createRuntimePrompt(fixture: ComparisonFixture): string {
  return [
    "You are comparing runtime behavior for the same coding task.",
    "Use the available tools to inspect and update the fixture as needed.",
    "Prefer read/write/edit for file operations. Use exec for runtime verification when useful.",
    "",
    `Workspace root: ${fixture.root}`,
    `Task: ${fixture.task}`,
    "",
    "When finished, summarize what you changed and what you observed about the runtime.",
  ].join("\n");
}

function runtimeLabel(runtime: RuntimeId): string {
  return runtime === "workspace" ? "Workspace" : "Sandbox";
}
