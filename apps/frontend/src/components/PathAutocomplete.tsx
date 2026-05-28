/**
 * Popover that appears under the thread composer while the input is in
 * !/path mode. Suggests VFS paths fetched from /files-list. Pure UI +
 * thin fetch effect; the URL building / completion math lives in
 * @/lib/path-autocomplete.
 */

import { useEffect, useRef, useState } from "react";
import { Folder, File as FileIcon } from "lucide-react";
import {
  buildListingUrl,
  filterAndRank,
  type ListingEntry,
} from "@/lib/path-autocomplete.js";

const DEBOUNCE_MS = 80;

interface PathAutocompleteProps {
  threadId: string;
  text: string;
  /** Fires with the chosen entry; parent decides what to do with it. */
  onAccept(entry: ListingEntry): void;
  /** Fires with the active index — used so Tab/Enter in the composer
   *  can accept without owning the popover state. */
  registerHandlers(handlers: {
    moveUp(): void;
    moveDown(): void;
    accept(): void;
    isOpen(): boolean;
  }): void;
}

export function PathAutocomplete({ threadId, text, onAccept, registerHandlers }: PathAutocompleteProps) {
  const [entries, setEntries] = useState<ListingEntry[]>([]);
  const [active, setActive] = useState(0);

  // Debounced fetch.
  useEffect(() => {
    const url = buildListingUrl(threadId, text);
    if (!url) {
      setEntries([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json() as { entries: ListingEntry[] };
        const prefix = text.trimStart().slice(1).trimEnd();
        setEntries(filterAndRank(body.entries, prefix));
        setActive(0);
      } catch {
        // Network errors are non-fatal; the popover stays empty.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [threadId, text]);

  // Expose keyboard navigation to the parent input so Tab / Enter /
  // Up / Down can be intercepted there.
  const entriesRef = useRef(entries);
  const activeRef  = useRef(active);
  entriesRef.current = entries;
  activeRef.current  = active;

  useEffect(() => {
    registerHandlers({
      moveUp:   () => setActive(a => Math.max(0, a - 1)),
      moveDown: () => setActive(a => Math.min(Math.max(entriesRef.current.length - 1, 0), a + 1)),
      accept:   () => {
        const entry = entriesRef.current[activeRef.current];
        if (entry) onAccept(entry);
      },
      isOpen:   () => entriesRef.current.length > 0,
    });
  }, [onAccept, registerHandlers]);

  if (entries.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg">
      <ul className="py-1 text-sm">
        {entries.map((entry, i) => (
          <li key={entry.path}>
            <button
              type="button"
              onMouseDown={(e) => {
                // Use mousedown so the click fires before the input loses focus.
                e.preventDefault();
                onAccept(entry);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                i === active ? "bg-kumo-tint text-kumo-default" : "text-kumo-default hover:bg-kumo-tint"
              }`}
            >
              {entry.type === "dir"
                ? <Folder className="size-3.5 shrink-0 text-kumo-inactive" />
                : <FileIcon className="size-3.5 shrink-0 text-kumo-inactive" />}
              <span className="truncate font-mono text-xs">{entry.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
