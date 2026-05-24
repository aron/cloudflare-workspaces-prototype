/**
 * InlineCode — the room-UI inline-code chip.
 *
 * Used by hand-authored JSX in Mockup.tsx. Streamdown's inline-code
 * elements (rendered inside `MessageResponse`) get the same styling via
 * the `[data-streamdown="inline-code"]` rule in styles.css, so the two
 * sources stay visually identical.
 */

import type { ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm bg-kumo-tint px-1 py-px font-mono text-sm text-kumo-brand">
      {children}
    </span>
  );
}
