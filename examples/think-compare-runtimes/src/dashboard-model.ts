import type { RunEvent, RuntimeId } from "../shared/events";
import { deriveRunSummary, type OverallRunStatus, type RuntimeRunStatus } from "./run-state";

export type ContainerState = "off" | "booting" | "asleep" | "awake";

export interface RuntimeDashboardModel {
  id: RuntimeId;
  status: RuntimeRunStatus;
  elapsedLabel: string;
  toolCalls: number;
  execCalls: number;
  container: ContainerState;
  error: string | null;
  events: RunEvent[];
}

export interface DashboardModel {
  run: {
    status: OverallRunStatus;
    elapsedLabel: string;
    actionLabel: "START RUN" | "RUN AGAIN";
  };
  runtimes: Record<RuntimeId, RuntimeDashboardModel>;
}

const runtimeIds: RuntimeId[] = ["workspace", "sandbox"];

export function buildDashboardModel(events: RunEvent[], nowIso: string | null): DashboardModel {
  const summary = deriveRunSummary(events);
  const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence);

  return {
    run: {
      status: summary.status,
      elapsedLabel: formatDuration(
        summary.elapsedMs ?? runningElapsedMs(summary.startedAt, summary.completedAt, nowIso),
      ),
      actionLabel:
        summary.status === "completed" || summary.status === "failed" ? "RUN AGAIN" : "START RUN",
    },
    runtimes: Object.fromEntries(
      runtimeIds.map((runtime) => {
        const runtimeSummary = summary.runtimes[runtime];
        const runtimeEvents = sortedEvents.filter((event) => event.runtime === runtime);
        const toolCalls = runtimeEvents.filter(isToolCall).length;
        const execCalls = runtimeEvents.filter(isExecCall).length;

        return [
          runtime,
          {
            id: runtime,
            status: runtimeSummary.status,
            elapsedLabel: formatDuration(
              runtimeSummary.elapsedMs ??
                runningElapsedMs(runtimeSummary.startedAt, runtimeSummary.completedAt, nowIso),
            ),
            toolCalls,
            execCalls,
            container: containerState(runtime, runtimeSummary.status, runtimeEvents, execCalls),
            error: runtimeSummary.error,
            events: runtimeEvents,
          },
        ];
      }),
    ) as Record<RuntimeId, RuntimeDashboardModel>,
  };
}

function runningElapsedMs(
  startedAt: string | null,
  completedAt: string | null,
  nowIso: string | null,
): number | null {
  if (!startedAt || completedAt || !nowIso) return null;
  const elapsed = Date.parse(nowIso) - Date.parse(startedAt);
  return Number.isNaN(elapsed) ? null : Math.max(0, elapsed);
}

export function formatDuration(elapsedMs: number | null): string {
  if (elapsedMs === null) return "--:--";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isToolCall(event: RunEvent): boolean {
  return event.kind === "tool_call" || event.kind === "agent_tool_call";
}

function isExecCall(event: RunEvent): boolean {
  if (!isToolCall(event)) return false;
  if (event.title.toLowerCase().includes("exec")) return true;

  try {
    const detail = JSON.parse(event.detail) as unknown;
    return Boolean(
      detail &&
        typeof detail === "object" &&
        "command" in detail &&
        typeof (detail as { command?: unknown }).command === "string",
    );
  } catch {
    return false;
  }
}

function containerState(
  runtime: RuntimeId,
  status: RuntimeRunStatus,
  events: RunEvent[],
  execCalls: number,
): ContainerState {
  if (runtime === "workspace") {
    return execCalls > 0 ? "awake" : "asleep";
  }

  if (status === "idle") return "off";
  if (
    events.some((event) => event.kind === "tool_call" || event.kind === "tool_result") ||
    execCalls > 0
  ) {
    return "awake";
  }
  return "booting";
}
