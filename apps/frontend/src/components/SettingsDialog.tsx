/**
 * User settings dialog — currently a single field for the user's Google
 * Workspace user ID, which the notifications backend uses to route Google
 * Chat webhook pings. Same lightweight modal shell as ConfirmDialog
 * (overlay + centred card, no Radix). Mounted at page level by RoomShell.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { fetchMySettings, updateMySettings, type Me } from "@/lib/api";

export function SettingsDialog({
  open,
  me,
  onClose,
}: {
  open:    boolean;
  me:      Me;
  onClose: () => void;
}) {
  const [value, setValue]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);

  // Pull current value whenever the dialog opens. Cheap and avoids stale data
  // if the user updates from another tab.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    fetchMySettings()
      .then(s => setValue(s.googleChatUserId ?? ""))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  // Use `%s` (string formatter) rather than `%d` here. Google user IDs are
  // 21-digit numbers — well beyond Number.MAX_SAFE_INTEGER — so `%d` would
  // coerce the string through Number() and silently round the trailing
  // digits to zero. The Chat webhook then 500s because no user with the
  // truncated id exists.
  const snippet =
    `console.log("Google Workspace User Id: %s", document.querySelector('[data-user-email="${me.email}"]').dataset.userId)`;

  const trimmed = value.trim();
  const looksValid = trimmed === "" || /^[0-9]{5,30}$/.test(trimmed);
  // Heuristic: a real Google user id is 21 random digits, so the odds of
  // it ending in four+ zeros are 1 in 10000. If we see that pattern the
  // user almost certainly pasted a precision-lost number from a `%d`
  // formatter or a JSON viewer that rendered the id as a number.
  const looksTruncated = /^[0-9]{17,}0{4,}$/.test(trimmed);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const next = trimmed === "" ? null : trimmed;
      const saved = await updateMySettings(next);
      setValue(saved.googleChatUserId ?? "");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; user can still select + copy manually */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => { if (!saving) onClose(); }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-[min(90vw,520px)] rounded-xl border border-kumo-line bg-kumo-base p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-kumo-default">Settings</h2>
        <p className="mt-1 text-xs text-kumo-inactive">Signed in as {me.email}.</p>

        <div className="mt-5">
          <label className="block text-sm font-medium text-kumo-default" htmlFor="gchat-id">
            Google Workspace user ID
          </label>
          <p className="mt-1 text-xs leading-5 text-kumo-inactive">
            Used to ping you in Google Chat when you&apos;re @mentioned in the Hackspace.
            To find your ID, open Google Chat in a space where you&apos;ve been mentioned
            and paste this into the browser console:
          </p>

          <div className="mt-2 flex gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-kumo-line bg-kumo-elevated px-2 py-1.5 text-[11px] leading-5 text-kumo-default">
              {snippet}
            </code>
            <Button variant="outline" size="sm" onClick={copySnippet}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <input
            id="gchat-id"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 115736912860088353887"
            value={value}
            disabled={loading || saving}
            onChange={e => setValue(e.target.value)}
            className="mt-4 block w-full rounded-md border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
          />
          {!looksValid && (
            <p className="mt-1 text-xs text-red-400">
              Must be 5–30 digits, or leave empty to clear.
            </p>
          )}
          {looksValid && looksTruncated && (
            <p className="mt-1 text-xs text-amber-400">
              This looks like a number that lost precision (trailing zeros).
              Re-run the console snippet to grab the raw string — don’t
              copy the id out of a JSON viewer or a <code>%d</code>-formatted log line.
            </p>
          )}

          {error && (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving || loading || !looksValid}
            className="bg-kumo-brand text-white hover:bg-kumo-brand-hover"
          >
            {saving ? "…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
