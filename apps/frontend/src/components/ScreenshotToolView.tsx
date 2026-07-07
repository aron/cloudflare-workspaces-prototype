/**
 * Specialized renderer for `tool-screenshot` parts.
 *
 * The screenshot tool captures a webpage in a headless browser, saves it to
 * the workspace, and (for vision models) also returns the image inline. Its
 * output carries `{ url, mediaType, bytes, path?, fileUrl?, error? }`. This
 * view renders a header with the source URL + status and, when available, an
 * inline thumbnail loaded from `fileUrl` (the workspace file-serving route).
 */
import { CameraIcon, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScreenshotOutput {
  url?: string;
  mediaType?: string;
  bytes?: number;
  path?: string;
  fileUrl?: string;
  error?: string;
}

interface ScreenshotToolViewProps {
  input?: { url?: string } | null;
  output?: ScreenshotOutput | null;
  errorText?: string;
  state?: string;
}

export function ScreenshotToolView({
  input,
  output,
  errorText,
  state,
}: ScreenshotToolViewProps) {
  const isRunning =
    !state || state === "input-streaming" || state === "input-available";
  const error = errorText ?? output?.error;
  const kind: "running" | "ok" | "fail" = error
    ? "fail"
    : isRunning
      ? "running"
      : "ok";

  const url = output?.url ?? input?.url ?? "";
  const fileUrl = output?.fileUrl;

  const chrome =
    kind === "ok" ? "border-emerald-500/40 bg-emerald-500/5"
    : kind === "fail" ? "border-red-500/40 bg-red-500/5"
    : "border-kumo-line";

  return (
    <div className={cn("my-2 overflow-hidden rounded-lg border", chrome)}>
      <header className="flex items-center gap-2 border-b border-current/20 px-3 py-1.5">
        {kind === "ok" && <CheckCircle2 className="size-4 text-emerald-400" />}
        {kind === "fail" && <XCircle className="size-4 text-red-400" />}
        {kind === "running" && (
          <Loader2 className="size-4 animate-spin text-kumo-inactive" />
        )}
        <CameraIcon className="size-3.5 text-kumo-inactive" />
        <span className="text-xs font-semibold text-kumo-default">Screenshot</span>
        {url && (
          <span className="truncate text-xs text-kumo-subtle" title={url}>
            {url}
          </span>
        )}
        {kind === "ok" && output?.bytes !== undefined && (
          <span className="ml-auto text-xs text-kumo-inactive">
            {Math.round(output.bytes / 1024)} KB
          </span>
        )}
      </header>

      {error && (
        <div className="px-3 py-2 text-xs text-red-400">{error}</div>
      )}

      {!error && fileUrl && (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={fileUrl}
            alt={`Screenshot of ${url}`}
            className="max-h-96 w-full object-contain bg-kumo-base"
            loading="lazy"
          />
        </a>
      )}

      {!error && !fileUrl && !isRunning && (
        <div className="px-3 py-2 text-xs text-kumo-subtle">
          {output?.path ? `Saved to ${output.path}` : "Captured."}
        </div>
      )}
    </div>
  );
}
