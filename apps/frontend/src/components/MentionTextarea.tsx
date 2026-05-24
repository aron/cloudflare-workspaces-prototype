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
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
  function MentionTextarea({ value, onChange, onKeyDown, ...rest }, externalRef) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(externalRef, () => innerRef.current!, []);

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

    return (
      <div className="relative">
        <textarea
          ref={innerRef}
          value={value}
          onChange={(e) => { onChange(e.target.value); syncCaret(); }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          {...rest}
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
