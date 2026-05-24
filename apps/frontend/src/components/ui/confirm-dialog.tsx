/**
 * Minimal modal confirmation dialog. No Radix dep — we don't need
 * focus-trap gymnastics for "are you sure?" prompts. Renders a fixed
 * overlay + centred card; the overlay click and Escape dismiss.
 *
 * Mounted at the page level by callers (e.g. RoomShell). Pass `open`
 * to control visibility and `onConfirm` / `onCancel` to react.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel  = "Cancel",
  destructive  = true,
  busy         = false,
  onConfirm,
  onCancel,
}: {
  open:          boolean;
  title:         string;
  description?:  React.ReactNode;
  confirmLabel?: string;
  cancelLabel?:  string;
  destructive?:  boolean;
  busy?:         boolean;
  onConfirm:     () => void;
  onCancel:      () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => { if (!busy) onCancel(); }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-[min(90vw,420px)] rounded-xl border border-kumo-line bg-kumo-base p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-kumo-default">{title}</h2>
        {description && (
          <div className="mt-2 text-sm leading-5 text-kumo-inactive">{description}</div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className={
              destructive
                ? "bg-red-900/60 text-red-100 hover:bg-red-900/80"
                : "bg-kumo-brand text-white hover:bg-kumo-brand-hover"
            }
          >
            {busy ? "…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
