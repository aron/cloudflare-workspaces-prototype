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

import { useMentionHandles } from "@/lib/useMentionCandidates";

const MENTION_RE = /(^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]{0,63})/gi;

const SKIP_TAGS = new Set(["CODE", "PRE", "A", "SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

export function MentionHighlighter({ children }: { children: ReactNode }) {
  const handles = useMentionHandles();
  const ref     = useRef<HTMLDivElement | null>(null);

  // Re-walk after every render so streaming output picks up new tokens. We
  // also observe DOM mutations because Streamdown re-renders subtrees in
  // place when a chunk arrives, which fires no React render of our wrapper.
  useEffect(() => {
    const root = ref.current;
    if (!root || handles.size === 0) return;

    const run = () => highlightMentions(root, handles);
    run();

    const mo = new MutationObserver(() => run());
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [handles]);

  return <div ref={ref}>{children}</div>;
}

/**
 * Walk every text node under `root` and wrap recognised mentions with
 * `<span data-mention="...">`. Exported for unit tests — pure DOM in,
 * pure DOM out, no React dependency.
 */
export function highlightMentions(root: HTMLElement, handles: ReadonlySet<string>) {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-mention]")) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.includes("@")) {
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
    wrapMentionsInTextNode(text, handles);
  }
}

function wrapMentionsInTextNode(node: Text, handles: ReadonlySet<string>) {
  const src = node.nodeValue!;
  let last = 0;
  let matched = false;
  const frag = node.ownerDocument.createDocumentFragment();

  for (const m of src.matchAll(MENTION_RE)) {
    const handle = m[2]!.toLowerCase();
    if (!handles.has(handle)) continue;
    const lead     = m[1] ?? "";
    const matchStart = (m.index ?? 0) + lead.length;
    const matchEnd   = matchStart + 1 + m[2]!.length;  // @ + handle

    if (matchStart > last) {
      frag.appendChild(node.ownerDocument.createTextNode(src.slice(last, matchStart)));
    }
    const span = node.ownerDocument.createElement("span");
    span.setAttribute("data-mention", handle);
    span.className = "rounded px-1 py-0.5 font-medium text-[#ff4801] bg-[#ffe9e0]";
    span.textContent = src.slice(matchStart, matchEnd);
    frag.appendChild(span);
    last = matchEnd;
    matched = true;
  }
  if (!matched) return;
  if (last < src.length) {
    frag.appendChild(node.ownerDocument.createTextNode(src.slice(last)));
  }
  node.parentNode?.replaceChild(frag, node);
}
