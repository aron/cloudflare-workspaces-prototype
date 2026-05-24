/**
 * Left-rail room list. Shared between RoomView and ThreadView so the user
 * can always jump between rooms.
 */

import { useEffect, useState } from "react";
import { listRooms, type RoomSummary } from "./api.js";
import { navigate } from "./nav.js";
import { colors, initials, relTime, s } from "./styles.js";

export function RoomSidebar({ activeRoomId }: { activeRoomId?: string }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listRooms().then(rs => { if (!cancelled) setRooms(rs); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <aside style={s.sidebar}>
      <div style={s.sidebarHeader}>
        <span style={s.sidebarTitle}>Rooms</span>
        <button style={s.primaryBtn} onClick={() => navigate({ kind: "picker" })}>+ New</button>
      </div>
      <div style={s.sidebarList}>
        {rooms.map(r => {
          const active = r.id === activeRoomId;
          return (
            <div
              key={r.id}
              style={{ ...s.roomItem, ...(active ? s.roomItemActive : {}) }}
              onClick={() => navigate({ kind: "room", roomId: r.id })}
            >
              <div style={{ ...s.roomAvatar, background: avatarColor(r.id) }}>{initials(r.name)}</div>
              <div style={s.roomMeta}>
                <span style={s.roomName}>{r.name}</span>
                <span style={s.roomSubtitle}>{relTime(r.createdAt)}</span>
              </div>
            </div>
          );
        })}
        {rooms.length === 0 && <div style={{ ...s.empty, marginTop: 16 }}>No rooms yet</div>}
      </div>
    </aside>
  );
}

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 30%, 28%)`;
}

// Suppress unused-var warning while colors stays exported for other modules.
void colors;
