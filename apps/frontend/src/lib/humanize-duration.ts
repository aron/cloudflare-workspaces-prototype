/**
 * Render a wall-clock duration in milliseconds for compact display next
 * to a tool call. The chat UI shows these in places where a single
 * glanceable label has to do everything — too coarse and a sub-100ms
 * call disappears into "0s", too fine and a 90-second build reads as
 * "92847ms" and overflows the badge.
 *
 * The breakpoints are picked from observed tool-call latencies:
 *   - <1s   → raw `ms` (covers most read/write/grep/stat/exec-cached)
 *   - <1m   → 1 decimal of seconds (the bulk of real exec work)
 *   - >=1m  → `Xm Ys` with seconds dropped when zero (long builds)
 *
 * Negative or non-finite inputs fall back to "0ms" so a clock-skew or
 * accidental NaN doesn't render garbage in the badge.
 *
 * Pure function — no React, no formatter state, safe to share between
 * the agent (when we eventually want server-side log lines) and the
 * frontend renderer.
 */
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
