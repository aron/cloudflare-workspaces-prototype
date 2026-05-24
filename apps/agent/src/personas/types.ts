/**
 * Persona — a self-contained behaviour profile for the Agent.
 *
 * Each persona owns:
 *   - the system prompt the LLM sees
 *   - which tools beyond the common file-ops set are available
 *
 * The agent looks up its current persona from DO state and threads it through
 * `onChatMessage`. Tools the persona doesn't list are not registered, so the
 * model can't call them.
 */

export type ToolName =
  // common file-ops tools (always available)
  | "read" | "write" | "edit" | "listDirectory" | "stat" | "mkdir"
  | "deleteFile" | "findFiles" | "grep" | "exec" | "webFetch" | "webSearch"
  // optional, persona-gated
  | "run"
  | "worker_deploy" | "worker_fetch";

export interface Persona {
  /** Stable identifier persisted in DO storage. */
  id:           string;
  /** Display name for UI / docs. */
  name:         string;
  /** Short, one-line description for persona pickers. */
  description:  string;
  /** Full system prompt threaded into streamText(). */
  systemPrompt: string;
  /** Tools beyond the always-on file-ops set. */
  extraTools:   ToolName[];
}

/** Tools every persona gets. */
export const COMMON_TOOLS: ToolName[] = [
  "read", "write", "edit", "listDirectory", "stat", "mkdir",
  "deleteFile", "findFiles", "grep", "exec", "webFetch", "webSearch",
];
