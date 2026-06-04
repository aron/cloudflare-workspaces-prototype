import type { RunEvent } from "../shared/events";

const starterEvents = [
  {
    runtime: "both",
    kind: "run_started",
    title: "Comparison run started",
    detail: "Workspace and Sandbox agents are queued from the same fixture.",
  },
  {
    runtime: "workspace",
    kind: "runtime_note",
    title: "Workspace file system ready",
    detail: "The Workspace side can inspect files from DOFS before a container starts.",
  },
  {
    runtime: "sandbox",
    kind: "runtime_note",
    title: "Sandbox container ready",
    detail: "The Sandbox side uses the container-backed filesystem from the beginning.",
  },
  {
    runtime: "workspace",
    kind: "tool_call",
    title: "read /workspace/repo/src/index.ts",
    detail: "Fake event: the real adapter will report model-selected tool calls here.",
  },
  {
    runtime: "sandbox",
    kind: "runtime_note",
    title: "Awaiting agent tool calls",
    detail: "Fake event: live runtime and transcript events will stream over this channel.",
  },
] as const;

export function createFakeRunEvents(runId: string): RunEvent[] {
  const timestamp = new Date(0).toISOString();

  return starterEvents.map((event, sequence) => ({
    ...event,
    id: `${runId}:${sequence}`,
    runId,
    sequence,
    timestamp,
  }));
}
