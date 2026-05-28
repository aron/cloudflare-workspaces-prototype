/**
 * Renders a `tool-exec` part with terminal-style chrome.
 *
 * Drop-in replacement for the generic <Tool> branch in ThreadPanel
 * when the part's tool name is "exec". Reads cumulative ExecSnapshot
 * shapes the agent's streaming generator yields:
 *
 *   {
 *     processId, running,
 *     stdout, stderr,
 *     stdoutTruncated?, stderrTruncated?,
 *     stdoutBinary?,    stderrBinary?,
 *     exitCode?, durationMs?,
 *     error?: { details }
 *   }
 *
 * Render modes:
 *   running        -> neutral chrome, "running…" badge, optional cancel
 *   exit zero      -> green chrome, "exit 0"
 *   non-zero exit  -> red chrome, "exit <n>"
 *   error          -> red chrome, "aborted" / "process lost" / etc.
 *
 * Backward compat: old persisted parts had the blocking shape
 * `{ stdout, stderr, exitCode }` with no processId. We render those
 * the same way as a final exec snapshot.
 */

import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExecSnapshot {
  processId?: string;
  running?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutBinary?: boolean;
  stderrBinary?: boolean;
  exitCode?: number;
  durationMs?: number;
  error?: { details?: string };
}

interface ExecToolViewProps {
  input?: { command?: string; cwd?: string };
  output?: ExecSnapshot | null;
  errorText?: string;
  state?: string;
  toolCallId?: string;
  onCancel?(toolCallId: string): void;
}

function statusFor(output?: ExecSnapshot | null, errorText?: string): {
  kind: "running" | "ok" | "fail";
  label: string;
} {
  if (errorText) return { kind: "fail", label: errorText };
  if (!output) return { kind: "running", label: "running…" };
  if (output.error?.details) {
    return { kind: "fail", label: output.error.details };
  }
  if (output.running) return { kind: "running", label: "running…" };
  if (output.exitCode === undefined) return { kind: "running", label: "running…" };
  return output.exitCode === 0
    ? { kind: "ok",   label: `exit ${output.exitCode}` }
    : { kind: "fail", label: `exit ${output.exitCode}` };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Render stdout and stderr in arrival order. With cumulative snapshots
 * the agent already produces them as full strings — we just concatenate
 * with a hairline visual cue for stderr.
 *
 * If a side is flagged binary we render the literal "<binary>" once
 * for that side, in place of any content.
 */
function renderStream(snap: ExecSnapshot): React.ReactNode {
  const lines: Array<{ stream: "out" | "err"; text: string }> = [];
  if (snap.stdoutBinary) {
    lines.push({ stream: "out", text: "<binary>" });
  } else if (snap.stdout) {
    lines.push({ stream: "out", text: snap.stdout });
  }
  if (snap.stderrBinary) {
    lines.push({ stream: "err", text: "<binary>" });
  } else if (snap.stderr) {
    lines.push({ stream: "err", text: snap.stderr });
  }
  if (lines.length === 0) return null;

  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-kumo-base p-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <span key={i} className={l.stream === "err" ? "text-yellow-400/80" : ""}>
          {l.text}
        </span>
      ))}
    </pre>
  );
}

export function ExecToolView({
  input, output, errorText, state, toolCallId, onCancel,
}: ExecToolViewProps) {
  const status = statusFor(output, errorText);
  const isRunning = status.kind === "running";
  const canCancel = isRunning && toolCallId
    && (state === "input-streaming" || state === "input-available");

  const chrome =
    status.kind === "ok"      ? "border-emerald-500/40 bg-emerald-500/5"
    : status.kind === "fail"  ? "border-red-500/40    bg-red-500/5"
    :                           "border-kumo-line";

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${chrome}`}>
      <header className="flex items-center gap-2 border-b border-current/20 px-3 py-1.5">
        {status.kind === "ok"   && <CheckCircle2 className="size-4 text-emerald-400" />}
        {status.kind === "fail" && <XCircle      className="size-4 text-red-400" />}
        {status.kind === "running" && <Loader2 className="size-4 animate-spin text-kumo-inactive" />}
        <span className="text-xs font-semibold uppercase tracking-wide text-kumo-default">exec</span>
        <code className="flex-1 truncate font-mono text-xs text-kumo-inactive">
          {input?.command ?? ""}
        </code>
        <span className={
          status.kind === "ok"      ? "text-xs text-emerald-400"
          : status.kind === "fail"  ? "text-xs text-red-400"
          :                           "text-xs text-kumo-inactive"
        }>{status.label}</span>
        {output?.durationMs !== undefined && status.kind !== "running" && (
          <span className="text-xs text-kumo-inactive">· {fmtDuration(output.durationMs)}</span>
        )}
      </header>

      <div className="p-3">
        {renderStream(output ?? {})}

        {(output?.stdoutTruncated || output?.stderrTruncated) && (
          <p className="mt-1 text-xs text-kumo-inactive">
            Output truncated at 2 MiB per stream.
          </p>
        )}

        {output?.error?.details && (
          <div className="mt-2 border-t border-red-500/20 pt-2 text-xs text-red-400">
            Error: {output.error.details}
          </div>
        )}
        {errorText && !output?.error?.details && (
          <div className="mt-2 border-t border-red-500/20 pt-2 text-xs text-red-400">
            Error: {errorText}
          </div>
        )}

        {canCancel && (
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => onCancel?.(toolCallId)}
              className="h-7 bg-red-900/40 text-red-300 hover:bg-red-900/60"
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
