/**
 * ReceiptsBuffer — the pure debounce + monotonicity helper extracted from
 * ReceiptsProvider so we can exercise the tricky bits (coalescing, stale
 * absorption, multi-scope independence) without a React renderer.
 */
import { describe, it, expect, vi } from "vitest";
import { ReceiptsBuffer } from "../src/lib/receipts-buffer";

/**
 * Tiny fake timer: schedule callbacks against a virtual clock and `tick()`
 * the clock forward. Beats real `setTimeout` for deterministic tests, and
 * doesn't touch vitest's global fake-timer state (which interacts oddly
 * with `Promise.resolve().then(...)`).
 */
function fakeTimers() {
  let now = 0;
  const queue: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    setTimeout(fn: () => void, ms: number) {
      const entry = { at: now + ms, fn, cancelled: false };
      queue.push(entry);
      return entry;
    },
    clearTimeout(handle: unknown) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    async tick(ms: number) {
      now += ms;
      const due = queue.filter(e => !e.cancelled && e.at <= now);
      for (const e of due) {
        e.cancelled = true;
        e.fn();
      }
      // Let any `Promise.resolve().then(...)` chains inside the emit
      // callback settle before the caller continues.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

describe("ReceiptsBuffer", () => {
  it("fires one emit per key after the debounce window", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    buf.push("room", "r1", 1000);
    expect(emit).not.toHaveBeenCalled();
    await t.tick(99);
    expect(emit).not.toHaveBeenCalled();
    await t.tick(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("room", "r1", 1000);
  });

  it("coalesces rapid pushes for the same key onto the largest timestamp", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    buf.push("thread", "t1", 1000);
    await t.tick(50);
    buf.push("thread", "t1", 2000);   // newer → re-arms timer
    await t.tick(50);                 // only 50ms since the second push
    expect(emit).not.toHaveBeenCalled();
    await t.tick(50);                 // window elapses
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("thread", "t1", 2000);
  });

  it("absorbs stale timestamps without emitting twice", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    expect(buf.push("room", "r1", 2000)).toBe(true);
    expect(buf.push("room", "r1", 1500)).toBe(false);  // stale, no re-arm
    expect(buf.push("room", "r1", 2000)).toBe(false);  // equal, no re-arm
    await t.tick(100);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("room", "r1", 2000);
  });

  it("tracks scopes independently", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    buf.push("room", "r1", 1000);
    buf.push("thread", "t1", 2000);
    buf.push("room", "r2", 3000);
    await t.tick(100);

    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledWith("room",   "r1", 1000);
    expect(emit).toHaveBeenCalledWith("thread", "t1", 2000);
    expect(emit).toHaveBeenCalledWith("room",   "r2", 3000);
  });

  it("rejects non-positive / non-finite timestamps", () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    expect(buf.push("room", "r1", 0)).toBe(false);
    expect(buf.push("room", "r1", -5)).toBe(false);
    expect(buf.push("room", "r1", Number.NaN)).toBe(false);
    expect(buf.push("room", "r1", Number.POSITIVE_INFINITY)).toBe(false);
    expect(buf.size()).toBe(0);
  });

  it("cancel() drops pending state without emitting", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    buf.push("room", "r1", 1000);
    buf.push("thread", "t1", 2000);
    expect(buf.size()).toBe(2);
    buf.cancel();
    expect(buf.size()).toBe(0);
    await t.tick(200);
    expect(emit).not.toHaveBeenCalled();
  });

  it("flush() emits everything pending synchronously and clears state", async () => {
    const t = fakeTimers();
    const emit = vi.fn().mockResolvedValue(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, timers: t });

    buf.push("room", "r1", 1000);
    buf.push("thread", "t1", 2000);
    buf.flush();
    // flush() schedules emits as microtasks; resolve them.
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(buf.size()).toBe(0);
  });

  it("routes emit failures to onError without poisoning future pushes", async () => {
    const t = fakeTimers();
    const onError = vi.fn();
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const buf = new ReceiptsBuffer({ debounceMs: 100, emit, onError, timers: t });

    buf.push("room", "r1", 1000);
    await t.tick(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("boom");

    buf.push("room", "r1", 2000);
    await t.tick(100);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("room", "r1", 2000);
  });
});
