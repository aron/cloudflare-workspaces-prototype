/**
 * Shared CSS-in-JS for the chat UI. Kept as plain objects so we don't pull
 * in a styling runtime — the bundle stays small and tree-shakeable.
 *
 * Palette + spacing are tuned to roughly match the hackspace mockup:
 * dark canvas, warm accent on primary actions, restrained borders.
 */

import type { CSSProperties } from "react";

export const colors = {
  bg:           "#0f0f0f",
  panel:        "#141414",
  panelAlt:     "#181818",
  border:       "#222",
  borderStrong: "#2a2a2a",
  text:         "#e0e0e0",
  textDim:      "#888",
  textMuted:    "#555",
  textBright:   "#fff",
  accent:       "#ef6c2a",  // hackspace orange
  accentHover:  "#ff7a3a",
  user:         "#1a3a5c",
  ok:           "#4ade80",
  warn:         "#facc15",
  err:          "#f87171",
} as const;

export const s: Record<string, CSSProperties> = {
  // ---- shell ----
  app:       { display: "grid", gridTemplateColumns: "260px 1fr", height: "100dvh",
                fontFamily: "system-ui, sans-serif", background: colors.bg, color: colors.text },
  appWithThread: { display: "grid", gridTemplateColumns: "260px 1fr 380px", height: "100dvh",
                fontFamily: "system-ui, sans-serif", background: colors.bg, color: colors.text },
  appSingle: { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 860,
                margin: "0 auto", padding: "0 16px", fontFamily: "system-ui, sans-serif",
                background: colors.bg, color: colors.text },

  // ---- left rail ----
  sidebar:        { borderRight: `1px solid ${colors.border}`, background: colors.panel,
                    display: "flex", flexDirection: "column", overflow: "hidden" },
  sidebarHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "14px 16px", borderBottom: `1px solid ${colors.border}` },
  sidebarTitle:   { fontWeight: 600, color: colors.textBright, fontSize: "0.95rem" },
  sidebarList:    { flex: 1, overflowY: "auto", padding: "8px 0" },
  roomItem:       { display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
                    cursor: "pointer", color: colors.text, fontSize: "0.85rem",
                    borderLeft: "3px solid transparent" },
  roomItemActive: { background: colors.panelAlt, borderLeftColor: colors.accent,
                    color: colors.textBright },
  roomAvatar:     { width: 28, height: 28, borderRadius: 6, background: "#2a4a2a",
                    color: colors.textBright, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: "0.78rem", fontWeight: 600 },
  roomMeta:       { display: "flex", flexDirection: "column", minWidth: 0 },
  roomName:       { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  roomSubtitle:   { color: colors.textMuted, fontSize: "0.72rem" },

  // ---- buttons ----
  primaryBtn:   { background: colors.accent, border: "none", borderRadius: 6, color: "#fff",
                  padding: "6px 12px", cursor: "pointer", fontSize: "0.8rem", fontWeight: 500 },
  primaryBtnLg: { background: colors.accent, border: "none", borderRadius: 6, color: "#fff",
                  padding: "10px 18px", cursor: "pointer", fontSize: "0.9rem", fontWeight: 500 },
  ghostBtn:     { background: "transparent", border: `1px solid ${colors.borderStrong}`,
                  borderRadius: 6, color: colors.text, padding: "6px 12px", cursor: "pointer",
                  fontSize: "0.8rem" },

  // ---- center (room timeline) ----
  main:         { display: "flex", flexDirection: "column", overflow: "hidden",
                  background: colors.bg },
  mainHeader:   { display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "14px 24px", borderBottom: `1px solid ${colors.border}` },
  mainTitle:    { fontWeight: 600, color: colors.textBright, fontSize: "1rem" },
  mainSubtitle: { color: colors.textMuted, fontSize: "0.78rem" },
  messages:     { flex: 1, overflowY: "auto", padding: "16px 24px",
                  display: "flex", flexDirection: "column", gap: 16 },
  messageRow:   { display: "flex", gap: 12, alignItems: "flex-start" },
  authorAvatar: { width: 30, height: 30, borderRadius: 6, background: "#3a3a3a",
                  color: colors.textBright, display: "flex", alignItems: "center",
                  justifyContent: "center", fontSize: "0.8rem", fontWeight: 600,
                  flexShrink: 0 },
  authorRow:    { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 },
  authorName:   { color: colors.textBright, fontWeight: 600, fontSize: "0.88rem" },
  authorTime:   { color: colors.textMuted, fontSize: "0.72rem" },
  messageBody:  { color: colors.text, fontSize: "0.88rem", lineHeight: 1.55,
                  whiteSpace: "pre-wrap" },
  threadLink:   { marginTop: 4, color: colors.accent, fontSize: "0.8rem", cursor: "pointer",
                  display: "inline-block", padding: "2px 0", textDecoration: "none" },

  // ---- composer ----
  composer:     { borderTop: `1px solid ${colors.border}`, padding: "14px 24px",
                  display: "flex", gap: 8 },
  composerInput:{ flex: 1, background: colors.panel, border: `1px solid ${colors.borderStrong}`,
                  borderRadius: 8, padding: "10px 14px", color: colors.text,
                  fontSize: "0.9rem", resize: "none", outline: "none", fontFamily: "inherit" },

  // ---- thread panel (right rail) ----
  thread:       { display: "flex", flexDirection: "column", borderLeft: `1px solid ${colors.border}`,
                  background: colors.panel, overflow: "hidden" },
  threadHeader: { display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "14px 16px", borderBottom: `1px solid ${colors.border}` },
  threadTitle:  { fontWeight: 600, color: colors.textBright, fontSize: "0.95rem" },
  threadSubtitle:{ color: colors.textMuted, fontSize: "0.72rem" },
  closeBtn:     { background: "transparent", border: "none", color: colors.textDim,
                  fontSize: "1.2rem", cursor: "pointer", padding: 0, lineHeight: 1 },

  // ---- empty/error states ----
  empty:    { color: colors.textMuted, textAlign: "center", marginTop: 40, fontSize: "0.9rem" },
  errorBox: { color: colors.err, padding: "10px 14px", margin: "16px 24px",
              background: "#2a1414", border: `1px solid ${colors.err}`, borderRadius: 6,
              fontSize: "0.85rem" },
};

/** Two-letter initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]!.slice(0, 2) || "?").toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Friendly relative-time label: "5m ago", "yesterday", date. */
export function relTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60)        return "just now";
  const m = Math.floor(s / 60);
  if (m < 60)        return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)        return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1)       return "yesterday";
  if (d < 7)         return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
