/**
 * Render a `<mention type="..." id="...">@label</mention>` tag from Streamdown
 * as a styled pill.
 *
 * Wire-up:
 *   <Streamdown
 *     allowedTags={{ mention: ["type", "id"] }}
 *     literalTagContent={["mention"]}
 *     components={{ mention: Mention }}
 *   >
 *
 * The component receives `type` and `id` as props (Streamdown surfaces tag
 * attributes verbatim) and the human label as children. We prefer the
 * embedded children, falling back to the candidate pool by id, then to a
 * generic placeholder for ids we don't recognise.
 */
import type { ReactNode } from "react";
import { useMentionCandidates } from "@/lib/useMentionCandidates";

export interface MentionProps {
  type?:    string;
  id?:      string;
  children?: ReactNode;
}

export function Mention({ type, id, children }: MentionProps) {
  const { refs } = useMentionCandidates();
  const kind = type === "agent" ? "agent" : "user";
  const safeId = (id ?? "").trim();
  const candidate = safeId ? refs.get(`${kind}:${safeId}`) : undefined;

  // Preference order: children (the model's chosen label), candidate handle,
  // fallback placeholder. We coerce children to string so we don't accidentally
  // render markup the model snuck inside the tag.
  const childText  = childrenToText(children).trim();
  const fallback   = kind === "agent" ? "@agent" : "@unknown";
  const candHandle = candidate ? `@${candidate.handle}` : "";
  const label      = childText || candHandle || fallback;

  return (
    <span
      data-mention={candidate?.handle ?? safeId}
      data-mention-type={kind}
      data-mention-id={safeId}
      className="rounded px-1 py-0.5 font-medium text-[#ff4801] bg-[#ffe9e0]"
    >
      {label}
    </span>
  );
}

function childrenToText(c: ReactNode): string {
  if (c == null || c === false) return "";
  if (typeof c === "string" || typeof c === "number") return String(c);
  if (Array.isArray(c)) return c.map(childrenToText).join("");
  // ReactElement or something exotic — `children` of a literalTagContent
  // tag in Streamdown is always a string, so this branch is defensive.
  return "";
}
