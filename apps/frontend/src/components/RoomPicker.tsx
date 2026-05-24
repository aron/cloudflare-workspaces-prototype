/**
 * Landing page rendered at `/`. Lists every room in the system and lets
 * any authenticated user create a new one. Picking a room navigates to
 * `/rooms/:id`.
 *
 * Tailwind + shadcn buttons; no app-specific layout beyond the centred
 * card. The full three-pane shell only appears once a room is selected.
 */

import { useCallback, useEffect, useState } from "react";
import { Hexagon, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { createRoom, listRooms } from "@/lib/api";
import type { Me, RoomSummary } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { initials, relTime } from "@/lib/utils";

const AVATAR_PALETTE = [
  "bg-[#ea7d3a]",
  "bg-[#3f8f7a]",
  "bg-[#a85f3d]",
  "bg-[#5a5a5a]",
  "bg-[#c89f5b]",
];

function avatarColor(id: string): string {
  // Deterministic palette pick per room id so the avatar feels stable
  // across renders without us having to persist anything.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function RoomPicker({ me }: { me: Me }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRooms(await listRooms());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const room = await createRoom(trimmed);
      setName("");
      navigate({ kind: "room", roomId: room.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [name]);

  return (
    <div className="flex min-h-screen w-screen flex-col bg-kumo-base text-kumo-default">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-kumo-line px-5">
        <div className="flex items-center gap-2.5">
          <Hexagon size={20} strokeWidth={2.5} className="text-kumo-brand" />
          <span className="text-md font-semibold tracking-tight">hackspace</span>
        </div>
        <div className="text-xs text-kumo-inactive">
          signed in as <span className="text-kumo-default">{me.name}</span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        <section className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
          <p className="text-sm text-kumo-inactive">
            Pick a room to join the conversation, or start a new one.
            Mention <code className="rounded bg-kumo-recessed px-1 py-0.5 text-xs">@go</code>,{" "}
            <code className="rounded bg-kumo-recessed px-1 py-0.5 text-xs">@zig</code>, or{" "}
            <code className="rounded bg-kumo-recessed px-1 py-0.5 text-xs">@cloudflare-worker</code>{" "}
            inside a room to spawn an agent thread.
          </p>
        </section>

        <section className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
            placeholder="Name a new room…"
            maxLength={80}
            className="flex-1 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm outline-none focus:border-kumo-ring focus:bg-kumo-base"
          />
          <Button
            onClick={() => void onCreate()}
            disabled={creating || !name.trim()}
            className="gap-1.5 bg-kumo-brand text-white hover:bg-kumo-brand-hover"
          >
            {creating ? <Spinner /> : <Plus className="size-4" strokeWidth={2.5} />}
            New room
          </Button>
        </section>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <section className="flex flex-col gap-2">
          {loading && rooms.length === 0 && (
            <div className="rounded-lg border border-dashed border-kumo-line px-4 py-8 text-center text-sm text-kumo-inactive">
              Loading rooms…
            </div>
          )}
          {!loading && rooms.length === 0 && (
            <div className="rounded-lg border border-dashed border-kumo-line px-4 py-8 text-center text-sm text-kumo-inactive">
              No rooms yet — create one above to get started.
            </div>
          )}
          {rooms.map(r => (
            <button
              key={r.id}
              onClick={() => navigate({ kind: "room", roomId: r.id })}
              className="group flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-3 text-left transition-colors hover:border-kumo-ring hover:bg-kumo-base"
            >
              <div
                className={`flex size-9 flex-shrink-0 items-center justify-center rounded-md font-semibold text-white ${avatarColor(r.id)}`}
              >
                {initials(r.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-kumo-default">{r.name}</div>
                <div className="text-xs text-kumo-inactive">created {relTime(r.createdAt)}</div>
              </div>
            </button>
          ))}
        </section>
      </main>
    </div>
  );
}
