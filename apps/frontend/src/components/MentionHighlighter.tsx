/**
 * Pill-style any `@mention` that appears in already-rendered children.
 *
 * Used to retrofit mention styling onto Streamdown markdown output (which
 * we don't control directly). Walks descendant text nodes after each
 * render and after the streaming markdown library mutates them, wrapping
 * matched substrings with `<span class="mention">`.
 *
 * The walker only touches text nodes — no risk of double-wrapping because
 * an already-wrapped mention sits inside a span and is skipped by
 * `acceptNode`. Existing handlers (links, code, inline-code) are skipped
 * too: we never look inside `code`, `pre`, `a`, or anything carrying the
 * `data-mention` attribute we just added.
 */
import { useEffect, useRef, type ReactNode } from "react";

import { useMentionCandidates, type MentionCandidate } from "@/lib/useMentionCandidates";

const MENTION_RE = /(^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]{0,63})/gi;
const REF_RE     = /<(user|agent):([A-Za-z0-9._-]{1,128})>/g;

const SKIP_TAGS = new Set(["CODE", "PRE", "A", "SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

export function MentionHighlighter({ children }: { children: ReactNode }) {
  const { handles, refs } = useMentionCandidates();
  const ref     = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const run = () => highlightMentions(root, handles, refs);
    run();

    const mo = new MutationObserver(() => run());
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [handles, refs]);

  return <div ref={ref}>{children}</div>;
}

/**
 * Walk every text node under `root` and wrap recognised mentions with
 * `<span data-mention="...">`. Exported for unit tests — pure DOM in,
 * pure DOM out, no React dependency.
 */
export function highlightMentions(
  root: HTMLElement,
  handles: ReadonlySet<string>,
  refs: ReadonlyMap<string, MentionCandidate> = new Map(),
) {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-mention]")) return NodeFilter.FILTER_REJECT;
        const v = node.nodeValue;
        if (!v || (!v.includes("@") && !v.includes("<"))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    targets.push(n as Text);
  }
  for (const text of targets) {
    wrapMentionsInTextNode(text, handles, refs);
  }
}

function wrapMentionsInTextNode(
  node: Text,
  handles: ReadonlySet<string>,
  refs: ReadonlyMap<string, MentionCandidate>,
) {
  const src = node.nodeValue!;
  // Collect ref-token hits and @-handle hits, then walk in order.
  type Hit = { start: number; end: number; handle: string; label: string };
  const hits: Hit[] = [];
  for (const m of src.matchAll(REF_RE)) {
    const start = m.index ?? 0;
    const c = refs.get(`${m[1]}:${m[2]}`);
    const handle = c?.handle ?? (m[1] === "agent" ? "agent" : m[2]!);
    const label  = c ? `@${c.handle}` : (m[1] === "agent" ? "@agent" : "@unknown");
    hits.push({ start, end: start + m[0]!.length, handle, label });
  }
  for (const m of src.matchAll(MENTION_RE)) {
    const handle = m[2]!.toLowerCase();
    if (!handles.has(handle)) continue;
    const lead = m[1] ?? "";
    const start = (m.index ?? 0) + lead.length;
    const end   = start + 1 + m[2]!.length;
    if (hits.some(h => start >= h.start && start < h.end)) continue;
    hits.push({ start, end, handle, label: src.slice(start, end) });
  }
  if (hits.length === 0) return;
  hits.sort((a, b) => a.start - b.start);

  const frag = node.ownerDocument.createDocumentFragment();
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue;
    if (h.start > last) {
      frag.appendChild(node.ownerDocument.createTextNode(src.slice(last, h.start)));
    }
    const span = node.ownerDocument.createElement("span");
    span.setAttribute("data-mention", h.handle);
    span.className = "rounded px-1 py-0.5 font-medium text-[#ff4801] bg-[#ffe9e0]";
    span.textContent = h.label;
    frag.appendChild(span);
    last = h.end;
  }
  if (last < src.length) {
    frag.appendChild(node.ownerDocument.createTextNode(src.slice(last)));
  }
  node.parentNode?.replaceChild(frag, node);
}
