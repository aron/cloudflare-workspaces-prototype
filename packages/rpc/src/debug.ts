// Stub leak tracking. Gated on the CAPNWEB_TRACK_STUBS env flag so
// production paths pay nothing. Every RpcTarget we own opts in by
// calling `trackStub(this)` in its constructor; capnweb invokes
// `[Symbol.dispose]` when the last remote stub for that target is
// disposed, which is where we decrement.
//
// The point is *measurement*, not enforcement: snapshot() returns the
// per-class live count so a soak script can assert "after a quiet
// point, every counter is zero." Anything non-zero is a leak —
// either we forgot to dispose a result envelope on the caller side,
// or the disposal contract broke.

// Read the flag once. Both Node (process.env) and workerd
// (globalThis env-style access via the runtime) are tolerated; if
// neither path resolves to "1" we no-op.
const TRACKING_ENABLED: boolean = readFlag();

function readFlag(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.CAPNWEB_TRACK_STUBS === "1") return true;
  } catch {
    // ignore — process isn't available in this runtime
  }
  // Allow a globalThis override for runtimes without process.env.
  const override = (globalThis as { CAPNWEB_TRACK_STUBS?: unknown }).CAPNWEB_TRACK_STUBS;
  return override === "1" || override === true;
}

const counters = new Map<string, number>();

export function trackStub(target: object): void {
  if (!TRACKING_ENABLED) return;
  const name = target.constructor?.name ?? "anonymous";
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function untrackStub(target: object): void {
  if (!TRACKING_ENABLED) return;
  const name = target.constructor?.name ?? "anonymous";
  const current = counters.get(name) ?? 0;
  if (current <= 1) counters.delete(name);
  else counters.set(name, current - 1);
}

// Snapshot the current live counts. Empty object when tracking is
// disabled or when nothing is live. Callers should not mutate the
// returned object — it's a fresh copy on every call.
export function stubSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of counters) out[name] = count;
  return out;
}

// True iff CAPNWEB_TRACK_STUBS=1 (or the globalThis override). Useful
// for skipping diagnostic surfaces when tracking is off.
export function isStubTrackingEnabled(): boolean {
  return TRACKING_ENABLED;
}
