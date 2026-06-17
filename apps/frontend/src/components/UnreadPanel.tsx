/**
 * Right-sidebar panel showing all scopes (rooms and threads) that have
 * unread activity, sorted by recency. Each entry is clickable and navigates
 * the user directly to the relevant room or thread.
 *
 * Data comes entirely from the ReceiptsProvider that wraps the app — no
 * extra fetches are needed beyond the initial snapshot that the provider
 * already owns. Room names are resolved via listRooms() once on mount.
 */

import { useEffect, useMemo, useState } from "react";
import { MessageCircle, X, Inbox } from "lucide-react";

import { listRooms } from "@/lib/api";
import type { RoomSummary } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { useReceipts } from "@/lib/receipts";
import { relTime } from "@/lib/utils";

// ---- types ----

interface UnreadItem {
  scope:    "room" | "thread";
  scopeId:  string;
  roomId:   string;         // same as scopeId for rooms; parent room for threads
  label:    string;         // display name
  subLabel: string;         // room name context for threads
  lastActivity: number;
}

// ---- component ----

export function UnreadPanel({ onClose }: { onClose: () => void }) {
  const { tips, tipRoomIds, isUnread, ready } = useReceipts();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  // Fetch room names once so we can label entries.
  useEffect(() => {
    let cancelled = false;
    listRooms()
      .then(rs => { if (!cancelled) setRooms(rs); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const roomNameById = useMemo(
    () => new Map(rooms.map(r => [r.id, r.name])),
    [rooms],
  );

  // Build sorted list of unread items from the live tips + receipts.
  const items = useMemo<UnreadItem[]>(() => {
    if (!ready) return [];

    const out: UnreadItem[] = [];

    for (const [key, lastActivity] of tips) {
      const [scope, scopeId] = key.split(":") as ["room" | "thread", string];
      if (!isUnread(scope, scopeId)) continue;

      if (scope === "room") {
        const label = roomNameById.get(scopeId) ?? scopeId;
        out.push({ scope, scopeId, roomId: scopeId, label, subLabel: "", lastActivity });
      } else {
        // Thread: look up parent roomId from the denormalised map.
        const roomId = tipRoomIds.get(scopeId);
        if (!roomId) continue; // no roomId yet — skip until the tip is fully known
        const roomName = roomNameById.get(roomId) ?? roomId;
        out.push({
          scope,
          scopeId,
          roomId,
          label:    `Thread`,
          subLabel: roomName,
          lastActivity,
        });
      }
    }

    // Most recent activity first.
    return out.sort((a, b) => b.lastActivity - a.lastActivity);
  }, [tips, tipRoomIds, isUnread, ready, roomNameById]);

  const handleClick = (item: UnreadItem) => {
    if (item.scope === "room") {
      navigate({ kind: "room", roomId: item.roomId });
    } else {
      navigate({ kind: "thread", roomId: item.roomId, threadId: item.scopeId });
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-kumo-line bg-kumo-base">
      {/* Header */}
      <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-kumo-line px-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Inbox size={15} className="text-kumo-brand" />
          Unread
          {items.length > 0 && (
            <span className="ml-0.5 rounded-full bg-kumo-brand px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-elevated hover:text-kumo-default"
          aria-label="Close unread panel"
        >
          <X size={15} />
        </button>
      </div>

      {/* List */}
      <div className="chat-panel flex-1 overflow-y-auto">
        {!ready ? (
          <div className="px-4 py-8 text-center text-xs text-kumo-inactive">Loading…</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <MessageCircle size={28} className="text-kumo-fill" />
            <p className="text-sm text-kumo-inactive">All caught up!</p>
          </div>
        ) : (
          <ul className="divide-y divide-kumo-line">
            {items.map(item => (
              <li key={`${item.scope}:${item.scopeId}`}>
                <button
                  type="button"
                  onClick={() => handleClick(item)}
                  className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-kumo-elevated"
                >
                  {/* Unread dot */}
                  <span className="mt-1.5 size-2 flex-shrink-0 rounded-full bg-kumo-brand" />

                  {/* Text */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-kumo-default group-hover:text-kumo-strong">
                        {item.label}
                      </span>
                      <span className="flex-shrink-0 text-[11px] text-kumo-inactive">
                        {relTime(item.lastActivity)}
                      </span>
                    </div>
                    {item.subLabel && (
                      <div className="mt-0.5 truncate text-xs text-kumo-inactive">
                        {item.subLabel}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
