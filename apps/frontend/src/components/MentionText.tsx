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
import { useMentionCandidates } from "@/lib/useMentionCandidates";


export function MentionText({ text, className }: { text: string; className?: string }) {
  const { handles, refs } = useMentionCandidates();
  const runs = useMemo(() => tokenize(text, handles), [text, handles]);
  if (runs.length === 0) return null;
  return (
    <span className={className}>
      {runs.map((r, i) => {
        if (r.type === "text") return <Fragment key={i}>{r.text}</Fragment>;
        if (r.type === "mention") return <MentionPill key={i} handle={r.handle} raw={r.raw} />;
        // r.type === "ref" — prefer the embedded label, fall back to the
        // candidate pool keyed on id, then to a generic placeholder.
        const c       = refs.get(`${r.kind}:${r.id}`);
        const handle  = c?.handle ?? (r.kind === "agent" ? "agent" : r.id);
        const display = r.label || (c ? `@${c.handle}` : (r.kind === "agent" ? "@agent" : "@unknown"));
        return <MentionPill key={i} handle={handle} raw={display} />;
      })}
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
