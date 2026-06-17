/**
 * Specialized renderer for `tool-delegate` parts.
 *
 * Replaces the generic <Tool> chrome for the `delegate` tool name
 * in ThreadPanel. Renders:
 *
 *   - A header with the sub-agent name, status badge, and duration.
 *   - The task description as readable prose (not JSON).
 *   - Live child progress via `useAgentToolEvents` — the sub-agent's
 *     own tool calls appear as collapsible rows while the run is active,
 *     and the final text response is rendered as markdown once done.
 *   - Clean failure states for `error`, `aborted`, and `interrupted`.
 *
 * The `agent-tool-event` frames are broadcast by the agents SDK over
 * the same WebSocket connection the parent thread uses. `useAgentToolEvents`
 * subscribes to them and returns `runsByToolCallId` so we can look up
 * the matching run by the parent's `toolCallId`.
 */

import {
  BotIcon,
  CheckCircle2,
  ChevronDownIcon,
  Loader2,
  WrenchIcon,
  XCircle,
} from "lucide-react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import { useAgentToolEvents } from "agents/react";
import type { AgentToolRunState } from "agents/agent-tools";
import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { humanizeDuration } from "@/lib/humanize-duration";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CodeBlock } from "@/components/ai-elements/code-block";

// ── Types ───────────────────────────────────────────────────────────

interface DelegateInput {
  name?: string;
  task?: string;
}

type PartialAgent = {
  addEventListener: (
    event: string,
    handler: (event: MessageEvent) => void
  ) => void;
  removeEventListener: (
    event: string,
    handler: (event: MessageEvent) => void
  ) => void;
};

// ── No-op agent for when the prop is absent ────────────────────────
// useAgentToolEvents calls addEventListener/removeEventListener on the
// agent synchronously in an effect; it cannot accept undefined. Provide
// a stable stub that satisfies the interface without doing anything.
const NOOP_AGENT: PartialAgent = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

interface DelegateToolViewProps {
  input?: DelegateInput | null;
  /** Raw tool-part output — string on success, AgentToolFailure on error. */
  output?: unknown;
  errorText?: string;
  state?: string;
  toolCallId?: string;
  callDurationMs?: number;
  /** The parent agent's socket, used to subscribe to agent-tool-event frames. */
  agent?: PartialAgent;
}

// ── Status helpers ───────────────────────────────────────────────────

type StatusKind = "running" | "ok" | "fail";

function resolveStatus(
  state?: string,
  output?: unknown,
  errorText?: string,
  run?: AgentToolRunState
): { kind: StatusKind; label: string } {
  if (errorText) return { kind: "fail", label: errorText };

  // Prefer the live run state from the event stream — it updates
  // before the tool-part state does.
  if (run) {
    if (run.status === "completed") return { kind: "ok",  label: "done" };
    if (run.status === "error")     return { kind: "fail", label: run.error ?? "error" };
    if (run.status === "aborted")   return { kind: "fail", label: "aborted" };
    if (run.status === "interrupted") return { kind: "fail", label: "interrupted" };
    return { kind: "running", label: "working…" };
  }

  if (!state || state === "input-streaming" || state === "input-available") {
    return { kind: "running", label: "working…" };
  }
  if (state === "output-error") {
    const failure = output as { ok?: boolean; error?: string } | null;
    return { kind: "fail", label: failure?.error ?? errorText ?? "error" };
  }
  if (state === "output-available") {
    const failure = output as { ok?: boolean } | null;
    if (failure && failure.ok === false) {
      const f = failure as { error?: string };
      return { kind: "fail", label: f.error ?? "failed" };
    }
    return { kind: "ok", label: "done" };
  }
  return { kind: "running", label: "working…" };
}

// ── Child part renderer ──────────────────────────────────────────────

const streamdownPlugins = { cjk, code, math, mermaid };

/**
 * Render a single part from the child agent's turn.
 * Text parts become markdown. Tool parts become compact collapsible rows.
 */
function ChildPart({ part }: { part: UIMessage["parts"][number] }) {
  const [open, setOpen] = useState(false);

  if (part.type === "text") {
    const text = (part as { type: "text"; text: string }).text.trim();
    if (!text) return null;
    return (
      <div className="text-sm text-kumo-default">
        <Streamdown plugins={streamdownPlugins}>{text}</Streamdown>
      </div>
    );
  }

  if (isToolUIPart(part)) {
    const name   = getToolName(part);
    const input  = (part as { input?: unknown }).input;
    const output = (part as { output?: unknown }).output;
    const isDone =
      part.state === "output-available" || part.state === "output-error";
    const icon =
      part.state === "output-available" ? (
        <CheckCircle2 className="size-3 text-emerald-400" />
      ) : part.state === "output-error" ? (
        <XCircle className="size-3 text-red-400" />
      ) : (
        <Loader2 className="size-3 animate-spin text-kumo-inactive" />
      );

    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-kumo-tint/60">
          {icon}
          <WrenchIcon className="size-3 text-kumo-inactive" />
          <span className="font-mono text-xs text-kumo-subtle">{name}</span>
          {!isDone && (
            <span className="ml-auto animate-pulse text-2xs text-kumo-inactive">
              running…
            </span>
          )}
          <ChevronDownIcon
            className={cn(
              "size-3 text-kumo-inactive transition-transform",
              open ? "rotate-180" : ""
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-4 mt-1 space-y-1.5 border-l border-kumo-line pl-3">
            {input != null && (
              <CodeBlock
                code={JSON.stringify(input, null, 2)}
                language="json"
                className="text-xs"
              />
            )}
            {output != null && (
              <CodeBlock
                code={
                  typeof output === "string"
                    ? output
                    : JSON.stringify(output, null, 2)
                }
                language="json"
                className="text-xs"
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return null;
}

// ── Main component ───────────────────────────────────────────────────

export function DelegateToolView({
  input,
  output,
  errorText,
  state,
  toolCallId,
  callDurationMs,
  agent,
}: DelegateToolViewProps) {
  // Subscribe to live agent-tool-event frames for this tool call.
  // useAgentToolEvents requires a non-null agent; provide a stable
  // no-op stub when the prop is absent so the hook contract is satisfied.
  const safeAgent = agent ?? NOOP_AGENT;
  const { getRunsForToolCall } = useAgentToolEvents({ agent: safeAgent as Parameters<typeof useAgentToolEvents>[0]["agent"] });
  const runs = toolCallId ? getRunsForToolCall(toolCallId) : [];
  // There should be exactly one run per delegate call — take the first.
  const run = runs[0] as AgentToolRunState | undefined;

  const status = resolveStatus(state, output, errorText, run);
  const isRunning = status.kind === "running";

  const chrome =
    status.kind === "ok"   ? "border-emerald-500/40 bg-emerald-500/5"
    : status.kind === "fail" ? "border-red-500/40 bg-red-500/5"
    :                          "border-kumo-line";

  // What to render in the body:
  // - While running: child's live parts from the event stream (tool calls + text).
  // - On success:    the final text output as markdown.
  // - On failure:    the error message.
  const childParts = run?.parts ?? [];
  const finalText =
    status.kind === "ok" && typeof output === "string" ? output.trim() : null;
  const failureMessage =
    status.kind === "fail"
      ? ((output as { error?: string } | null)?.error ?? errorText ?? status.label)
      : null;

  const hasBody = childParts.length > 0 || finalText || failureMessage;

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${chrome}`}>
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-current/20 px-3 py-1.5">
        {status.kind === "ok"      && <CheckCircle2 className="size-4 text-emerald-400" />}
        {status.kind === "fail"    && <XCircle      className="size-4 text-red-400" />}
        {status.kind === "running" && <Loader2      className="size-4 animate-spin text-kumo-inactive" />}

        <BotIcon className="size-3.5 text-kumo-inactive" />
        <span className="text-xs font-semibold text-kumo-default">
          {input?.name ?? "sub-agent"}
        </span>

        <span className={cn(
          "text-xs",
          status.kind === "ok"      ? "text-emerald-400"
          : status.kind === "fail"  ? "text-red-400"
          :                           "text-kumo-inactive"
        )}>
          {status.label}
        </span>

        {callDurationMs !== undefined && !isRunning && (
          <span className="ml-auto text-xs text-kumo-inactive">
            {humanizeDuration(callDurationMs)}
          </span>
        )}
      </header>

      {/* Task description */}
      {input?.task && (
        <div className="border-b border-kumo-line/60 px-3 py-2">
          <p className="text-2xs uppercase tracking-wide text-kumo-inactive mb-1">Task</p>
          <p className="text-sm text-kumo-subtle leading-snug whitespace-pre-wrap">
            {input.task}
          </p>
        </div>
      )}

      {/* Body — child parts while running, final output or error when done */}
      {hasBody && (
        <div className="space-y-1.5 p-3">
          {/* Child's live / persisted parts (tool calls + streaming text) */}
          {childParts.length > 0 &&
            childParts.map((part, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <ChildPart key={i} part={part} />
            ))}

          {/* Final markdown output (replaces child parts once the run is done) */}
          {finalText && childParts.length === 0 && (
            <div className="text-sm text-kumo-default">
              <Streamdown plugins={streamdownPlugins}>{finalText}</Streamdown>
            </div>
          )}

          {/* Error message */}
          {failureMessage && (
            <div className="border-t border-red-500/20 pt-2 text-xs text-red-400">
              {failureMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
