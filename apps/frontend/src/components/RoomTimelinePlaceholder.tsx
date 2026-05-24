/**
 * Centre pane stub. Fetches room metadata so the header is right but
 * doesn't render messages yet — the real wiring lands in the next commit.
 */

import { useEffect, useState } from "react";

import { fetchRoomMeta } from "@/lib/api";
import type { RoomMeta } from "@/lib/api";

export function RoomTimelinePlaceholder({ roomId }: { roomId: string }) {
  const [meta, setMeta]   = useState<RoomMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null); setError(null);
    fetchRoomMeta(roomId).then(m => { if (!cancelled) setMeta(m); })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [roomId]);

  return (
    <section className="flex h-full min-w-0 flex-col border-r border-kumo-line">
      <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold">
            {error ? "(error)" : meta?.name ?? "Loading…"}
          </h1>
          {meta && (
            <div className="mt-0.5 text-xs text-kumo-inactive">room {meta.id.slice(0, 8)}</div>
          )}
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center text-sm text-kumo-inactive">
        {error ? error : "Timeline coming online — next commit wires messages."}
      </div>
    </section>
  );
}
