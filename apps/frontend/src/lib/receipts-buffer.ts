/**
 * Pure, framework-free debounce + monotonicity logic for read receipts.
 * Extracted from ReceiptsProvider so it can be unit-tested without a React
 * renderer (the frontend test setup is plain Node + vitest, no jsdom).
 *
 * Contract:
 *   - `push(scope, scopeId, lastRead)` arms (or re-arms) a debounce timer
 *     for that key. The PUT fires once the key has been quiet for
 *     `debounceMs`, carrying the *largest* timestamp seen during the window.
 *   - Stale timestamps (< the largest already queued for that key) are
 *     coalesced away \u2014 the buffer never emits a smaller value than one it
 *     has already promised.
 *   - `flush()` cancels all pending timers and synchronously emits whatever
 *     each key currently holds. Useful for tests, and a clean-shutdown hook.
 *   - `cancel()` drops timers and pending state without emitting. Useful for
 *     `useEffect` cleanup.
 *
 * The emit callback returns a `Promise<void>`; failures are caught and
 * surfaced through the optional `onError` hook so a transient network error
 * doesn't poison subsequent calls.
 */

import type { ReceiptScope } from "@app/shared";

type Key = `${ReceiptScope}:${string}`;
const k = (scope: ReceiptScope, scopeId: string): Key => `${scope}:${scopeId}`;

export interface ReceiptsBufferOptions {
  debounceMs: number;
  emit:    (scope: ReceiptScope, scopeId: string, lastRead: number) => Promise<unknown>;
  onError?: (err: unknown) => void;
  /** Test seam. Defaults to the real timer pair. */
  timers?: {
    setTimeout:   (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

interface Pending {
  ts:     number;
  handle: unknown;
}

export class ReceiptsBuffer {
  private readonly opts:    ReceiptsBufferOptions;
  private readonly setT:    (fn: () => void, ms: number) => unknown;
  private readonly clearT:  (handle: unknown) => void;
  private readonly pending: Map<Key, Pending> = new Map();

  constructor(opts: ReceiptsBufferOptions) {
    this.opts   = opts;
    this.setT   = opts.timers?.setTimeout   ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.timers?.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Queue (or coalesce onto) a write. Returns true when this call advanced
   * the pending timestamp, false when it was stale and absorbed.
   */
  push(scope: ReceiptScope, scopeId: string, lastRead: number): boolean {
    if (!Number.isFinite(lastRead) || lastRead <= 0) return false;
    const key = k(scope, scopeId);
    const existing = this.pending.get(key);
    if (existing && lastRead <= existing.ts) {
      // Stale \u2014 the timer keeps running with the larger value.
      return false;
    }
    if (existing) this.clearT(existing.handle);
    const ts = lastRead;
    const handle = this.setT(() => {
      // Capture the latest value before deleting (push could have run again
      // between the timer firing and the callback executing, though with
      // real timers that can't happen).
      const current = this.pending.get(key);
      this.pending.delete(key);
      const value = current?.ts ?? ts;
      Promise.resolve()
        .then(() => this.opts.emit(scope, scopeId, value))
        .catch(err => this.opts.onError?.(err));
    }, this.opts.debounceMs);
    this.pending.set(key, { ts, handle });
    return true;
  }

  /**
   * Synchronously fire every pending emit and clear the buffer. Used by
   * tests and on clean shutdown.
   */
  flush(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, p] of entries) {
      this.clearT(p.handle);
      const [scope, scopeId] = key.split(":") as [ReceiptScope, string];
      Promise.resolve()
        .then(() => this.opts.emit(scope, scopeId, p.ts))
        .catch(err => this.opts.onError?.(err));
    }
  }

  /** Drop pending state without emitting. */
  cancel(): void {
    for (const p of this.pending.values()) this.clearT(p.handle);
    this.pending.clear();
  }

  /** Inspect pending state. For tests / debugging. */
  size(): number { return this.pending.size; }
}
