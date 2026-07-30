/**
 * Renders a `tool-exec` part with terminal-style chrome.
 *
 * Drop-in replacement for the generic <Tool> branch in ThreadPanel
 * when the part's tool name is "exec". Reads the output shape the
 * package's exec tool returns:
 *
 *   { command, cwd, backend, exitCode, stdout, stderr }
 *   { command, cwd, backend, error }                     // failed call
 *
 * The agent additionally wraps every tool for per-call cancellation,
 * which reports failures as `{ error: { details } }`.
 *
 * Render modes:
 *   no output yet  -> neutral chrome, "running…" badge, optional cancel
 *   exit zero      -> green chrome, "exit 0"
 *   non-zero exit  -> red chrome, "exit <n>"
 *   error          -> red chrome, the error message
 *
 * Backward compat: parts persisted by the pre-package exec tool carry
 * `running` / `durationMs` / `metadata` fields, so those are still
 * read when present.
 */

import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { humanizeDuration } from "@/lib/humanize-duration";

/** Legacy metadata block, only present on pre-package persisted parts. */
export interface ExecMetadata {
  backend?: string;
  commandKind?: "git" | "assets" | "artifact" | "shell";
}

export interface ExecSnapshot {
  command?: string;
  cwd?: string | null;
  backend?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** A string from the package's exec tool, `{ details }` from the agent's wrapper. */
  error?: string | { details?: string };
  running?: boolean;
  durationMs?: number;
  metadata?: ExecMetadata;
}

interface ExecToolViewProps {
  input?: { command?: string; cwd?: string; backend?: string };
  output?: ExecSnapshot | null;
  errorText?: string;
  state?: string;
  toolCallId?: string;
  onCancel?(toolCallId: string): void;
}

/** Normalise both error encodings to a message, or undefined. */
export function execErrorMessage(output?: ExecSnapshot | null): string | undefined {
  const err = output?.error;
  if (!err) return undefined;
  if (typeof err === "string") return err;
  return err.details ?? undefined;
}

export function statusFor(output?: ExecSnapshot | null, errorText?: string): {
  kind: "running" | "ok" | "fail";
  label: string;
} {
  if (errorText) return { kind: "fail", label: errorText };
  if (!output) return { kind: "running", label: "running…" };
  const message = execErrorMessage(output);
  if (message) return { kind: "fail", label: message };
  if (output.running) return { kind: "running", label: "running…" };
  if (output.exitCode === undefined) return { kind: "running", label: "running…" };
  return output.exitCode === 0
    ? { kind: "ok",   label: `exit ${output.exitCode}` }
    : { kind: "fail", label: `exit ${output.exitCode}` };
}

export function execEnvironmentLabel(input?: { backend?: string }, output?: ExecSnapshot | null): string {
  const backend = output?.backend ?? output?.metadata?.backend ?? input?.backend ?? "shell";
  const commandKind = output?.metadata?.commandKind;
  return commandKind && commandKind !== "shell" ? `${backend} · ${commandKind}` : backend;
}

function hasVisibleStream(snap: ExecSnapshot): boolean {
  return Boolean(snap.stdout || snap.stderr);
}

/**
 * Render stdout and stderr in arrival order, with a hairline visual
 * cue for stderr. Both arrive as complete strings (the package's exec
 * tool truncates them itself).
 */
function renderStream(snap: ExecSnapshot): React.ReactNode {
  const lines: Array<{ stream: "out" | "err"; text: string }> = [];
  if (snap.stdout) lines.push({ stream: "out", text: snap.stdout });
  if (snap.stderr) lines.push({ stream: "err", text: snap.stderr });
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
  const errorMessage = execErrorMessage(output);
  const isRunning = status.kind === "running";
  const envLabel = execEnvironmentLabel(input, output);
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
        <span className="rounded border border-kumo-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-kumo-inactive">
          {envLabel}
        </span>
        <code className="flex-1 truncate font-mono text-xs text-kumo-inactive">
          {input?.command ?? ""}
        </code>
        <span className={
          status.kind === "ok"      ? "text-xs text-emerald-400"
          : status.kind === "fail"  ? "text-xs text-red-400"
          :                           "text-xs text-kumo-inactive"
        }>{status.label}</span>
        {output?.durationMs !== undefined && status.kind !== "running" && (
          <span className="text-xs text-kumo-inactive">· {humanizeDuration(output.durationMs)}</span>
        )}
      </header>

      <div className="p-3">
        {renderStream(output ?? {})}

        {output && !isRunning && !hasVisibleStream(output) && !errorMessage && (
          <p className="rounded bg-kumo-base p-3 font-mono text-xs text-kumo-inactive">
            No stdout/stderr output captured.
          </p>
        )}

        {errorMessage && (
          <div className="mt-2 border-t border-red-500/20 pt-2 text-xs text-red-400">
            Error: {errorMessage}
          </div>
        )}
        {errorText && !errorMessage && (
          <div className="mt-2 border-t border-red-500/20 pt-2 text-xs text-red-400">
            Error: {errorText}
          </div>
        )}

        {canCancel && (
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => onCancel?.(toolCallId)}
              className="h-7 bg-kumo-danger text-white hover:brightness-95"
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
