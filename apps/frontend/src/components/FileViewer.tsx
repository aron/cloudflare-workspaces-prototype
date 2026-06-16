/**
 * Inline file viewer entry — rendered in the thread stream alongside
 * chat messages. Triggered by typing `!/<absolute-path>` in the
 * composer. Local-only: not persisted, not sent to the agent.
 *
 * State machine:
 *   loading -> ready (kind = image | text | download)
 *           -> error
 *
 * The heavy lifting (HEAD, sniff, GET) lives in useFileViewerEntry so
 * this file is mostly presentation.
 */

import { useEffect, useState } from "react";
import { X, FileWarning, Copy, Check } from "lucide-react";
import { decideKind, type ViewerKind } from "@/lib/viewer-kind.js";

const MAX_TEXT_BYTES = 256 * 1024;
const SNIFF_BYTES = 8 * 1024;

export interface FileViewerEntry {
  id: string;
  createdAt: number;
  path: string;       // absolute VFS path
  url: string;        // /api/threads/<tid>/files<path>
}

interface LoadedState {
  status: "loading" | "error" | "ready";
  kind?: ViewerKind;
  contentType?: string;
  size?: number;
  text?: string;
  error?: string;
}

function useFileViewerEntry(entry: FileViewerEntry): LoadedState {
  const [state, setState] = useState<LoadedState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        // HEAD: learn content-type + size cheaply.
        const head = await fetch(entry.url, { method: "HEAD", signal: controller.signal });
        if (!head.ok) throw new Error(`${head.status} ${head.statusText}`);
        const contentType = head.headers.get("content-type") ?? "application/octet-stream";
        const size        = Number(head.headers.get("content-length") ?? 0);

        // Quick path: image kinds never need a body fetch here.
        const cheapKind = decideKind({ contentType, size }, { maxTextBytes: MAX_TEXT_BYTES });
        if (cheapKind === "image" || (cheapKind === "download" && !contentType.toLowerCase().startsWith("application/octet-stream"))) {
          if (!cancelled) setState({ status: "ready", kind: cheapKind, contentType, size });
          return;
        }

        // For text or ambiguous octet-stream, fetch enough bytes to
        // decide. If under the cap we go for the whole thing so we can
        // render inline; otherwise just sniff and download-link.
        if (cheapKind === "text") {
          const res  = await fetch(entry.url, { signal: controller.signal });
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const text = await res.text();
          if (!cancelled) setState({ status: "ready", kind: "text", contentType, size, text });
          return;
        }

        // octet-stream: sniff first, then either GET the whole file or
        // fall back to download.
        if (size <= MAX_TEXT_BYTES) {
          const sniffRes = await fetch(entry.url, {
            signal: controller.signal,
            headers: { range: `bytes=0-${SNIFF_BYTES - 1}` },
          });
          if (!sniffRes.ok && sniffRes.status !== 206) {
            throw new Error(`${sniffRes.status} ${sniffRes.statusText}`);
          }
          const sniffBytes = new Uint8Array(await sniffRes.arrayBuffer());
          const finalKind = decideKind(
            { contentType, size, sniffBytes },
            { maxTextBytes: MAX_TEXT_BYTES },
          );
          if (finalKind === "text") {
            // We may already have the whole file if size <= SNIFF_BYTES.
            const text = sniffBytes.byteLength >= size
              ? new TextDecoder().decode(sniffBytes)
              : await (await fetch(entry.url, { signal: controller.signal })).text();
            if (!cancelled) setState({ status: "ready", kind: "text", contentType, size, text });
            return;
          }
        }

        if (!cancelled) setState({ status: "ready", kind: "download", contentType, size });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entry.url]);

  return state;
}

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? p : p.slice(slash + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

interface FileViewerProps {
  entry: FileViewerEntry;
  onDismiss(id: string): void;
}

export function FileViewer({ entry, onDismiss }: FileViewerProps) {
  const state = useFileViewerEntry(entry);
  // Copy-button state. Two outcomes worth surfacing:
  //   "ok"   — short-lived “copied” acknowledgement.
  //   "err"  — same lifetime; reverts to idle so the user can try again.
  // Each render reset is keyed by Date.now() on the timer so a rapid
  // double-click doesn't cancel the still-running acknowledgement.
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const t = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(t);
  }, [copyState]);

  // Decide what "copy" means per content kind:
  //   text     → raw text body.
  //   image    → the file URL (clipboard image writes need an ArrayBuffer
  //              + a clipboard permission and don't work in every browser;
  //              the URL is universally useful and what the agent's prompt
  //              already encourages users to share).
  //   download → the file URL.
  //   loading/error → button is disabled.
  const canCopy = state.status === "ready";
  const copy = async () => {
    if (!canCopy) return;
    try {
      const payload =
        state.kind === "text" && typeof state.text === "string"
          ? state.text
          : new URL(entry.url, window.location.origin).toString();
      await navigator.clipboard.writeText(payload);
      setCopyState("ok");
    } catch {
      // Most likely cause: clipboard API unavailable (non-secure context)
      // or the user denied permission. Surface a brief error tick and
      // let them try again; no toast / dialog needed.
      setCopyState("err");
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated">
      <div className="flex items-center gap-2 border-b border-kumo-line px-3 py-1.5">
        <code className="flex-1 truncate text-xs text-kumo-inactive">{entry.path}</code>
        {state.status === "ready" && state.size !== undefined && (
          <span className="text-xs text-kumo-inactive">{formatSize(state.size)}</span>
        )}
        <button
          type="button"
          aria-label={
            copyState === "ok"  ? "Copied" :
            copyState === "err" ? "Copy failed" :
            state.kind === "text" ? "Copy file contents" : "Copy file URL"
          }
          title={
            copyState === "ok"  ? "Copied" :
            copyState === "err" ? "Copy failed" :
            state.kind === "text" ? "Copy file contents" : "Copy file URL"
          }
          onClick={copy}
          disabled={!canCopy}
          className="rounded p-1 text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-kumo-inactive"
        >
          {copyState === "ok"
            ? <Check className="size-3.5 text-kumo-brand" />
            : <Copy className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => onDismiss(entry.id)}
          className="rounded p-1 text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="p-3">
        {state.status === "loading" && (
          <div className="text-sm text-kumo-inactive">Loading…</div>
        )}
        {state.status === "error" && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <FileWarning className="size-4" />
            Couldn't load {basename(entry.path)}: {state.error}
          </div>
        )}
        {state.status === "ready" && state.kind === "image" && (
          <img
            src={entry.url}
            alt={entry.path}
            className="max-h-[60vh] max-w-full rounded border border-kumo-line"
          />
        )}
        {state.status === "ready" && state.kind === "text" && (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-kumo-base p-3 text-xs text-kumo-default">
            {state.text}
          </pre>
        )}
        {state.status === "ready" && state.kind === "download" && (
          <a
            href={`${entry.url}?download`}
            download={basename(entry.path)}
            className="inline-block rounded bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover"
          >
            Download {basename(entry.path)}
          </a>
        )}
      </div>
    </div>
  );
}
