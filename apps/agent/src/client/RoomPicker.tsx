/**
 * Landing page: list of rooms + create form. Renders at `/`.
 */

import { useCallback, useEffect, useState } from "react";
import { createRoom, listRooms, type RoomSummary } from "./api.js";
import { navigate } from "./nav.js";
import { colors, initials, relTime, s } from "./styles.js";

export function RoomPicker({ userName }: { userName: string }) {
  const [rooms, setRooms]   = useState<RoomSummary[]>([]);
  const [error, setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

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
    <div style={pickerStyles.shell}>
      <header style={pickerStyles.header}>
        <div>
          <div style={s.mainTitle}>hackspace</div>
          <div style={s.mainSubtitle}>signed in as {userName}</div>
        </div>
      </header>

      <section style={pickerStyles.body}>
        <div style={pickerStyles.createBox}>
          <input
            style={pickerStyles.createInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name a new room…"
            maxLength={80}
            onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
          />
          <button
            style={s.primaryBtnLg}
            onClick={() => void onCreate()}
            disabled={creating || !name.trim()}
          >+ New room</button>
        </div>

        {error && <div style={s.errorBox}>{error}</div>}

        <div style={pickerStyles.list}>
          {loading && rooms.length === 0 && <div style={s.empty}>Loading rooms…</div>}
          {!loading && rooms.length === 0 && (
            <div style={s.empty}>No rooms yet — create one above to get started.</div>
          )}
          {rooms.map(r => (
            <button
              key={r.id}
              style={pickerStyles.card}
              onClick={() => navigate({ kind: "room", roomId: r.id })}
            >
              <div style={{ ...s.roomAvatar, background: avatarColor(r.id) }}>{initials(r.name)}</div>
              <div style={pickerStyles.cardBody}>
                <div style={pickerStyles.cardName}>{r.name}</div>
                <div style={s.roomSubtitle}>created {relTime(r.createdAt)}</div>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// Deterministic muted color per room id so the avatar feels stable.
function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 30%, 28%)`;
}

const pickerStyles: Record<string, React.CSSProperties> = {
  shell:        { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 720,
                  margin: "0 auto", padding: "0 24px", background: colors.bg, color: colors.text,
                  fontFamily: "system-ui, sans-serif" },
  header:       { padding: "24px 0 16px", borderBottom: `1px solid ${colors.border}` },
  body:         { flex: 1, overflowY: "auto", paddingTop: 20, display: "flex",
                  flexDirection: "column", gap: 16 },
  createBox:    { display: "flex", gap: 8 },
  createInput:  { flex: 1, background: colors.panel, border: `1px solid ${colors.borderStrong}`,
                  borderRadius: 8, padding: "10px 14px", color: colors.text, fontSize: "0.9rem",
                  outline: "none" },
  list:         { display: "flex", flexDirection: "column", gap: 8 },
  card:         { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
                  background: colors.panel, border: `1px solid ${colors.border}`,
                  borderRadius: 8, color: colors.text, cursor: "pointer", textAlign: "left" },
  cardBody:     { display: "flex", flexDirection: "column", minWidth: 0 },
  cardName:     { color: colors.textBright, fontWeight: 600, fontSize: "0.95rem" },
};
