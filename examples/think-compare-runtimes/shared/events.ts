export type RuntimeId = "workspace" | "sandbox";
export type EventRuntime = RuntimeId | "both";

export type RunEventKind =
  | "run_started"
  | "runtime_note"
  | "tool_call"
  | "tool_result"
  | "tool_error";

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  runtime: EventRuntime;
  kind: RunEventKind;
  title: string;
  detail: string;
  timestamp: string;
}
