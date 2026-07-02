/**
 * Specialized renderer for `tool-cloudflare` parts — the interactive
 * Cloudflare OAuth onboarding card.
 *
 * The `cloudflare` tool is a streaming tool. On `connect`, it yields an
 * interim `{ phase: "awaiting_auth", authUrl }` chunk (surfaced here as the
 * part's `output`) and then stays pending while the server polls for the
 * connection to become READY. This view renders that chunk as a card with:
 *
 *   - Continue → opens the OAuth authUrl in a new tab.
 *   - Cancel   → cancels the tool call (via `onCancel(toolCallId)`), which
 *                aborts the server-side poll.
 *
 * When the poll resolves, the tool's final output replaces the chunk with a
 * terminal phase (`ready` / `cancelled` / `timeout` / `failed`), which this
 * view renders as success/neutral/error chrome. `status`/`disconnect` produce
 * a single terminal object and render the same way.
 */
import {
  CheckCircle2,
  CloudIcon,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface CloudflareOutput {
  phase?: "awaiting_auth" | "ready" | "cancelled" | "timeout" | "failed";
  authUrl?: string | null;
  title?: string;
  message?: string;
  error?: string | null;
  // status/disconnect terminal shapes:
  state?: string;
  disconnected?: boolean;
}

interface CloudflareToolViewProps {
  output?: CloudflareOutput | null;
  errorText?: string;
  state?: string;
  toolCallId?: string;
  onCancel?(toolCallId: string): void;
}

type Kind = "await" | "running" | "ok" | "neutral" | "fail";

function resolve(
  output: CloudflareOutput | null | undefined,
  partState: string | undefined,
  errorText: string | undefined,
): { kind: Kind; label: string } {
  if (errorText) return { kind: "fail", label: errorText };

  const phase = output?.phase;
  if (phase === "awaiting_auth") return { kind: "await", label: "Waiting for authorization" };
  if (phase === "ready") return { kind: "ok", label: "Connected" };
  if (phase === "cancelled") return { kind: "neutral", label: "Cancelled" };
  if (phase === "timeout") return { kind: "fail", label: "Timed out waiting for authorization" };
  if (phase === "failed") return { kind: "fail", label: output?.error ?? "Failed" };

  // status/disconnect terminal shapes
  if (output?.disconnected) return { kind: "neutral", label: "Disconnected" };
  if (output?.state === "ready") return { kind: "ok", label: "Connected" };
  if (output?.state === "authenticating") return { kind: "await", label: "Authorization required" };
  if (output?.state === "disconnected") return { kind: "neutral", label: "Not connected" };
  if (output?.error) return { kind: "fail", label: output.error };

  // No output yet — tool call is in flight.
  if (!partState || partState === "input-streaming" || partState === "input-available") {
    return { kind: "running", label: "Connecting…" };
  }
  return { kind: "running", label: "Connecting…" };
}

export function CloudflareToolView({
  output,
  errorText,
  state,
  toolCallId,
  onCancel,
}: CloudflareToolViewProps) {
  const status = resolve(output, state, errorText);
  const authUrl = output?.authUrl ?? null;
  // The auth card is live only while the part is still pending (not yet a
  // terminal output). Once the tool returns, phase moves past awaiting_auth.
  const isPending =
    !state || state === "input-streaming" || state === "input-available";
  const showAuthCard = status.kind === "await" && isPending && !!authUrl;

  const chrome =
    status.kind === "ok" ? "border-emerald-500/40 bg-emerald-500/5"
    : status.kind === "fail" ? "border-red-500/40 bg-red-500/5"
    : status.kind === "await" ? "border-kumo-brand/40 bg-kumo-brand/5"
    : "border-kumo-line";

  const icon =
    status.kind === "ok" ? <CheckCircle2 className="size-4 text-emerald-400" />
    : status.kind === "fail" ? <XCircle className="size-4 text-red-400" />
    : status.kind === "await" || status.kind === "running"
      ? <Loader2 className="size-4 animate-spin text-kumo-inactive" />
      : <CloudIcon className="size-4 text-kumo-inactive" />;

  return (
    <div className={cn("my-2 overflow-hidden rounded-lg border", chrome)}>
      <header className="flex items-center gap-2 border-b border-current/20 px-3 py-1.5">
        {icon}
        <CloudIcon className="size-3.5 text-kumo-inactive" />
        <span className="text-xs font-semibold text-kumo-default">Cloudflare</span>
        <span
          className={cn(
            "text-xs",
            status.kind === "ok" ? "text-emerald-400"
            : status.kind === "fail" ? "text-red-400"
            : status.kind === "await" ? "text-kumo-brand"
            : "text-kumo-inactive",
          )}
        >
          {status.label}
        </span>
      </header>

      {showAuthCard && (
        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-medium text-kumo-default">
              {output?.title ?? "Authorize Cloudflare access"}
            </p>
            <p className="mt-1 text-sm text-kumo-subtle leading-snug">
              {output?.message ??
                "Open the authorization link to grant access to your Cloudflare account. This window keeps waiting until you finish."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (authUrl) window.open(authUrl, "_blank", "noopener,noreferrer");
              }}
              className="h-8 gap-1.5 bg-kumo-brand text-white hover:brightness-95"
            >
              <ExternalLink className="size-3.5" />
              Continue
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (toolCallId) onCancel?.(toolCallId);
              }}
              className="h-8"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Terminal timeout still shows the (stale) link so the user can retry. */}
      {status.kind === "fail" && output?.phase === "timeout" && authUrl && (
        <div className="px-4 py-3 text-sm text-kumo-subtle">
          Authorization timed out.{" "}
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-kumo-brand underline"
          >
            Open the link
          </a>{" "}
          and ask again to reconnect.
        </div>
      )}
    </div>
  );
}
