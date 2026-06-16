/**
 * Textarea with `@mention` autocomplete.
 *
 * Behaves like a normal controlled `<textarea>` (value/onChange) but layers
 * a popover that opens whenever the caret is parked inside a `@token` and
 * closes when it isn't. Selection is keyboard-first:
 *
 *   ↑ / ↓     move highlight
 *   Enter     accept the highlighted row (does NOT send the message)
 *   Tab       accept the highlighted row
 *   Escape    close the popover and let Enter fall through to the parent
 *
 * The parent's own `onKeyDown` is invoked only when the popover decides
 * the event isn't theirs — so the existing "Enter to send" behaviour
 * keeps working when no popover is open or the user has pressed Esc.
 *
 * No portals, no positioning libraries: the popover renders relative to
 * the textarea wrapper with absolute positioning. That's good enough for
 * the chat composers, which sit at the bottom of their pane and always
 * want the menu above.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";

import { applyMention, findActiveMention } from "@/lib/mentions";
import {
  filterCandidates,
  useMentionCandidates,
  type MentionCandidate,
} from "@/lib/useMentionCandidates";

type BaseProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>;

export interface MentionTextareaProps extends BaseProps {
  value:    string;
  onChange: (next: string) => void;
  /**
   * Grow the textarea height to fit its content as the user types,
   * up to `autoExpandMaxLines` lines (default 8). Caps further at the
   * distance to the top of the viewport so a long paste never pushes
   * the composer out of view. When false (or omitted), the textarea
   * stays at whatever `rows`/CSS height the consumer set.
   */
  autoExpand?: boolean;
  /** Hard line cap for auto-expand mode. Defaults to 8. */
  autoExpandMaxLines?: number;
}

// Vertical headroom kept between the top of the composer and the top of
// the viewport when the line cap is overridden by the viewport check.
// Keeps a bit of the scrollback visible above the composer so the user
// always has context for what they're typing about.
const VIEWPORT_HEADROOM_PX = 80;

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
  function MentionTextarea(
    { value, onChange, onKeyDown, autoExpand = false, autoExpandMaxLines = 8, style, ...rest },
    externalRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(externalRef, () => innerRef.current!, []);

    // Auto-expand sizing.
    //
    // Strategy: reset to `auto` height (so scrollHeight reflects the
    // intrinsic content height, not the previous expanded one), then
    // set the inline height to min(content, max-lines, viewport-room).
    // useLayoutEffect runs synchronously after the DOM has the new
    // value but before paint, so the user never sees a flash at the
    // wrong height.
    //
    // The line cap comes from computed `line-height`. Falling back to
    // 24px (1.5rem; matches the existing leading-6 utility on both
    // composers) keeps the cap sensible on browsers that report a
    // non-numeric value (e.g. "normal").
    useLayoutEffect(() => {
      if (!autoExpand) return;
      const el = innerRef.current;
      if (!el) return;
      // Reset so scrollHeight reflects content, not the current height.
      el.style.height = "auto";
      const computed = window.getComputedStyle(el);
      const parsedLineHeight = parseFloat(computed.lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : 24;
      const paddingY =
        (parseFloat(computed.paddingTop) || 0) +
        (parseFloat(computed.paddingBottom) || 0);
      const borderY =
        (parseFloat(computed.borderTopWidth) || 0) +
        (parseFloat(computed.borderBottomWidth) || 0);
      const linesCap = lineHeight * autoExpandMaxLines + paddingY + borderY;
      // Viewport cap — the top of the textarea's bounding box should
      // never go above VIEWPORT_HEADROOM_PX. Anything bigger and we'd
      // be pushing the composer off-screen.
      const rect = el.getBoundingClientRect();
      const viewportCap = Math.max(
        lineHeight + paddingY + borderY, // never collapse below one line
        rect.bottom - VIEWPORT_HEADROOM_PX,
      );
      const target = Math.min(el.scrollHeight, linesCap, viewportCap);
      el.style.height = `${target}px`;
    }, [value, autoExpand, autoExpandMaxLines]);

    const { candidates } = useMentionCandidates();
    const [caret,    setCaret]    = useState(0);
    const [open,     setOpen]     = useState(false);
    const [active,   setActive]   = useState(0);

    // Recompute on every value/caret change. `active` (the mention region)
    // also tells us whether the popover should be open.
    const mention = useMemo(() => findActiveMention(value, caret), [value, caret]);
    const matches = useMemo(
      () => mention ? filterCandidates(candidates, mention.prefix) : [],
      [candidates, mention],
    );

    // Toggle the popover. We keep `open` as separate state so Escape can
    // suppress it without us having to invent a "manually closed" flag
    // tracked against `mention.start`.
    useEffect(() => {
      if (mention && matches.length > 0) {
        setOpen(true);
        setActive(a => Math.min(a, matches.length - 1));
      } else {
        setOpen(false);
        setActive(0);
      }
    }, [mention?.start, mention?.prefix, matches.length]);

    const accept = useCallback((choice: MentionCandidate) => {
      if (!mention) return;
      const next = applyMention(value, mention, choice.handle);
      onChange(next.text);
      setOpen(false);
      // Restore the caret after React's re-render. Inputs are still in
      // the same node, so the timing works without an extra layout pass.
      queueMicrotask(() => {
        const el = innerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    }, [mention, onChange, value]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (open && matches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive(a => (a + 1) % matches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive(a => (a - 1 + matches.length) % matches.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          accept(matches[active]!);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return;
        }
      }
      onKeyDown?.(e);
    }, [open, matches, active, accept, onKeyDown]);

    // Mirror caret changes from every input route a textarea can take.
    const syncCaret = useCallback(() => {
      const el = innerRef.current;
      if (el) setCaret(el.selectionStart ?? 0);
    }, []);

    // Auto-expand mode owns the inline height, so we clear any incoming
    // `style.height` to avoid a useLayoutEffect <-> caller fight. Other
    // style keys (e.g. min-width) still pass through.
    const mergedStyle = autoExpand
      ? { ...(style ?? {}), height: undefined, overflow: "auto" as const }
      : style;

    return (
      <div className="relative">
        <textarea
          ref={innerRef}
          value={value}
          {...rest}
          onChange={(e) => { onChange(e.target.value); syncCaret(); }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          style={mergedStyle}
        />
        {open && matches.length > 0 && (
          <MentionPopover
            matches={matches}
            active={active}
            onPick={accept}
            onHover={setActive}
          />
        )}
      </div>
    );
  },
);

function MentionPopover({
  matches,
  active,
  onPick,
  onHover,
}: {
  matches: MentionCandidate[];
  active:  number;
  onPick:  (c: MentionCandidate) => void;
  onHover: (i: number) => void;
}) {
  // Anchor the popover to the top of the textarea wrapper (composers live
  // at the bottom of their pane). `bottom-full` puts it just above.
  return (
    <div
      role="listbox"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base shadow-stack"
    >
      {matches.map((c, i) => (
        <button
          key={c.handle}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
            i === active ? "bg-kumo-tint" : "hover:bg-kumo-elevated"
          }`}
        >
          <span className="rounded px-1 text-xs font-medium text-[#ff4801] bg-[#ffe9e0]">
            @{c.handle}
          </span>
          <span className="min-w-0 flex-1 truncate text-kumo-default">{c.label}</span>
          <span className="ml-auto text-2xs uppercase tracking-wide text-kumo-inactive">
            {c.kind}
          </span>
        </button>
      ))}
    </div>
  );
}
