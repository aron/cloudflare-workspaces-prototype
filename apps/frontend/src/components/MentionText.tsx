/**
 * Render plain text with `@mentions` styled as pills.
 *
 * Used inside user message bubbles (and anywhere else we have raw text we
 * trust to render verbatim — never set `dangerouslySetInnerHTML`). Pills
 * are a light-orange chip with brand text per product spec.
 *
 * We pill any handle that appears in the live candidate pool. Unknown
 * `@foo` tokens render as plain text so the chrome doesn't lie about
 * who's a real participant.
 */
import { Fragment, useMemo } from "react";

import { tokenize } from "@/lib/mentions";
import { useMentionHandles } from "@/lib/useMentionCandidates";

export function MentionText({ text, className }: { text: string; className?: string }) {
  const handles = useMentionHandles();
  const runs = useMemo(() => tokenize(text, handles), [text, handles]);
  if (runs.length === 0) return null;
  return (
    <span className={className}>
      {runs.map((r, i) => r.type === "text"
        ? <Fragment key={i}>{r.text}</Fragment>
        : <MentionPill key={i} handle={r.handle} raw={r.raw} />,
      )}
    </span>
  );
}

export function MentionPill({ handle, raw }: { handle: string; raw?: string }) {
  return (
    <span
      data-mention={handle}
      className="rounded px-1 py-0.5 font-medium text-[#ff4801] bg-[#ffe9e0]"
    >
      {raw ?? `@${handle}`}
    </span>
  );
}
