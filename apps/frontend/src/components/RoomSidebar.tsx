/**
 * Left rail rendered whenever the user is inside a room (or thread).
 * Lists the live set of rooms from the AppDO, highlights the active one,
 * and shows the signed-in user at the bottom.
 *
 * Visual structure is straight from Mockup.tsx — search box, RoomListItem
 * cards, identity pill — wired against `listRooms()` and `navigate()`.
 */

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/SettingsDialog";
import { fetchMySettings } from "@/lib/api";
import { listRooms } from "@/lib/api";
import type { Me, RoomSummary } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { useReceipts } from "@/lib/receipts";
import { initials, relTime } from "@/lib/utils";

const AVATAR_PALETTE = [
  "bg-[#ea7d3a]",
  "bg-[#3f8f7a]",
  "bg-[#a85f3d]",
  "bg-[#5a5a5a]",
  "bg-[#c89f5b]",
];

function avatarIdx(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % AVATAR_PALETTE.length;
}

export function RoomSidebar({
  me,
  activeRoomId,
}: {
  me:            Me;
  activeRoomId?: string;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [hasGChatId, setHasGChatId]         = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRooms().then(rs => { if (!cancelled) setRooms(rs); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load once so we can show a dot indicating whether notifications are wired.
  // Re-fetched on every dialog close to reflect changes.
  useEffect(() => {
    let cancelled = false;
    fetchMySettings()
      .then(s => { if (!cancelled) setHasGChatId(!!s.googleChatUserId); })
      .catch(() => { if (!cancelled) setHasGChatId(null); });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  const visible = filter.trim()
    ? rooms.filter(r => r.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : rooms;

  // Unread indicator per room — cheap selector lookup, no extra fetch.
  const { isUnread } = useReceipts();

  return (
    <aside className="flex h-full flex-col border-r border-kumo-line bg-kumo-base">
      <div className="flex h-14 flex-shrink-0 items-center justify-between px-5">
        <h2 className="text-md font-semibold">Rooms</h2>
        <Button
          size="sm"
          onClick={() => navigate({ kind: "picker" })}
          className="h-8 gap-1.5 rounded-lg bg-kumo-brand px-2.5 text-sm font-medium text-white hover:bg-kumo-brand-hover"
        >
          <Plus className="size-3" strokeWidth={2.5} />
          New
        </Button>
      </div>

      <div className="px-4 pb-3">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 focus-within:border-kumo-ring focus-within:bg-kumo-base">
          <Search size={14} className="text-kumo-inactive" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search rooms…"
            className="block w-full border-0 bg-transparent p-0 text-sm outline-none placeholder:text-kumo-inactive"
          />
        </div>
      </div>

      <div className="chat-panel flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {visible.map(r => (
          <RoomListItem
            key={r.id}
            letter={initials(r.name).slice(0, 1)}
            title={r.name}
            meta={relTime(r.createdAt)}
            active={r.id === activeRoomId}
            idx={avatarIdx(r.id)}
            unread={isUnread("room", r.id)}
            onClick={() => navigate({ kind: "room", roomId: r.id })}
          />
        ))}
        {visible.length === 0 && (
          <div className="mt-4 px-2 text-center text-xs text-kumo-inactive">
            {filter ? "no matches" : "no rooms yet"}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        className="flex h-12 flex-shrink-0 items-center gap-2.5 border-t border-kumo-line px-4 text-left hover:bg-kumo-elevated"
      >
        <div className={`flex size-8 flex-shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white ${AVATAR_PALETTE[avatarIdx(me.userId)]}`}>
          {initials(me.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{me.email}</div>
        </div>
        {hasGChatId !== null && (
          <span
            title={hasGChatId ? "Google Chat notifications on" : "Google Chat notifications off"}
            className={`size-2 flex-shrink-0 rounded-full ${hasGChatId ? "bg-emerald-500" : "bg-kumo-line"}`}
          />
        )}
      </button>
      <SettingsDialog open={settingsOpen} me={me} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}

function RoomListItem({
  letter,
  title,
  meta,
  active = false,
  idx = 0,
  onClick,
  unread = false,
}: {
  letter:  string;
  title:   string;
  meta:    string;
  active?: boolean;
  idx?:    number;
  onClick?: () => void;
  /** Show an unread dot. Driven by ReceiptsProvider's `isUnread` selector. */
  unread?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active
          ? "border-kumo-line bg-kumo-elevated"
          : "border-transparent hover:border-kumo-line hover:bg-kumo-elevated"
      }`}
    >
      <div
        className={`flex size-9 flex-shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white shadow-sm ring-1 ring-black/5 ${AVATAR_PALETTE[idx % AVATAR_PALETTE.length]}`}
      >
        {letter}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="truncate text-base font-medium text-kumo-default">{title}</div>
          {unread && (
            <span
              aria-label="Unread"
              title="Unread messages"
              className="size-2 flex-shrink-0 rounded-full bg-kumo-brand"
            />
          )}
        </div>
        <div className="truncate text-xs text-kumo-inactive">{meta}</div>
      </div>
    </button>
  );
}
