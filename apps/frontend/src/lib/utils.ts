import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
