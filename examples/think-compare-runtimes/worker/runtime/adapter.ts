import type { RuntimeId } from "../../shared/events";
import type { RunEventRecorder } from "../run-events";
import { createRuntimeFileTools, type RuntimeFileStore, type RuntimeFileTools } from "./file-tools";
import { createSandboxFileStore } from "./sandbox";
import { createWorkspaceFileStore } from "./workspace";

export interface RuntimeAdapter {
  runtime: RuntimeId;
  files: RuntimeFileTools;
}

type WorkspaceRuntimeAdapterOptions = {
  recorder: RunEventRecorder;
} & (
  | { workspace: Parameters<typeof createWorkspaceFileStore>[0]; store?: never }
  | { store: RuntimeFileStore; workspace?: never }
);

type SandboxRuntimeAdapterOptions = {
  recorder: RunEventRecorder;
} & (
  | { sandbox: Parameters<typeof createSandboxFileStore>[0]; store?: never }
  | { store: RuntimeFileStore; sandbox?: never }
);

export function createWorkspaceRuntimeAdapter(
  options: WorkspaceRuntimeAdapterOptions,
): RuntimeAdapter {
  const { recorder } = options;
  const runtime = "workspace";

  const store = options.store ?? createWorkspaceFileStore(options.workspace);

  return {
    runtime,
    files: createRuntimeFileTools({
      runtime,
      recorder,
      store,
    }),
  };
}

export function createSandboxRuntimeAdapter(options: SandboxRuntimeAdapterOptions): RuntimeAdapter {
  const { recorder } = options;
  const runtime = "sandbox";

  const store = options.store ?? createSandboxFileStore(options.sandbox);

  return {
    runtime,
    files: createRuntimeFileTools({
      runtime,
      recorder,
      store,
    }),
  };
}
