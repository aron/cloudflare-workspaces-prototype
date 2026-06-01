// Bidirectional sync driver. Pairs a local Database with a remote
// SyncRPC stub and runs pull + push ticks against the wire.
//
// Both sides of the prototype use the same driver: the container
// (wsd) drives an upstream DO stub, and once the DO has a real
// runtime it'll drive a container stub the same way.
//
// The driver doesn't own a timer. The caller decides when to call
// `pullOnce()` and `pushOnce()` \u2014 a polling loop in production,
// a manual `tick()` in tests so convergence is deterministic.

import {
  applyChanges,
  assertAppliedPushRev,
  type ChangeEntry,
  coalesceChanges,
  currentRev,
  type Database,
  readWatermark,
  stageBlob,
  writeWatermark,
} from "@cloudflare/dofs";

import type { SyncRPC } from "./interface.js";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// Pull every entry the remote has produced since the last successful
// pull, apply locally, advance fetchRev. Returns the number of
// entries applied so callers can decide whether to tick again.
//
// Bytes the receiver already holds (vfs_blobs.hash present) are
// skipped on the wire; the hasObjects probe is what makes that
// dedup work without per-chunk round-trips.
export async function pullOnce(db: Database, remote: SyncRPC): Promise<number> {
  const sinceRev = readWatermark(db, "fetchRev");
  // Capture the remote's currentRev BEFORE we drain its stream so
  // the watermark we advance to is consistent with what the
  // stream actually carried. If we read it after, a write that
  // landed remote-side mid-stream could push us past it without
  // the receiver having applied it.
  const remoteRev = await remote.currentRev();
  if (remoteRev <= sinceRev) return 0;

  const stream = await remote.fetchChanges({ sinceRev });
  const entries: ChangeEntry[] = [];
  const wantedHashes: Uint8Array[] = [];
  const seenHash = new Set<string>();
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      entries.push(value);
      if (value.kind === "file") {
        for (const c of value.chunks) {
          const k = hex(c.hash);
          if (!seenHash.has(k)) {
            seenHash.add(k);
            wantedHashes.push(c.hash);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (wantedHashes.length > 0) {
    const haveSubset = await remote.hasObjects(wantedHashes);
    // hasObjects answers "which of these does the receiver have"
    // \u2014 from the remote's perspective. We want "which does
    // the local store lack". Same query, against the local DB.
    const remoteHasLocally = new Set<string>();
    for (const h of haveSubset) remoteHasLocally.add(hex(h));
    // Probe local: anything the remote knows about that we don't
    // hold yet must be fetched.
    const missing = wantedHashes.filter((h) => {
      const k = hex(h);
      if (!remoteHasLocally.has(k)) return false; // remote doesn't have it either
      const row = db.one<{ hash: Uint8Array }>("SELECT hash FROM vfs_blobs WHERE hash = ?", h);
      return row === undefined;
    });
    if (missing.length > 0) {
      const bytesStream = await remote.fetchObjects(missing);
      const bytesReader = bytesStream.getReader();
      try {
        while (true) {
          const { value, done } = await bytesReader.read();
          if (done) break;
          stageBlob(db, value.hash, value.bytes, Date.now());
        }
      } finally {
        bytesReader.releaseLock();
      }
    }
  }

  await applyChanges(db, entries, new Map(), {
    source: "upstream",
    advanceFetchRev: remoteRev,
  });
  return entries.length;
}

// Push every entry the local store has produced since the last
// successful push. The wire shape mirrors pullOnce in reverse:
// stage bytes the remote lacks, then push the entry stream.
export async function pushOnce(db: Database, remote: SyncRPC): Promise<number> {
  const sincePush = readWatermark(db, "pushRev");
  const localRev = currentRev(db);
  if (localRev <= sincePush) return 0;

  const entries: ChangeEntry[] = [];
  const wantedHashes: Uint8Array[] = [];
  const seenHash = new Set<string>();
  for await (const e of coalesceChanges(db, sincePush)) {
    entries.push(e);
    if (e.kind === "file") {
      for (const c of e.chunks) {
        const k = hex(c.hash);
        if (!seenHash.has(k)) {
          seenHash.add(k);
          wantedHashes.push(c.hash);
        }
      }
    }
  }
  if (entries.length === 0) return 0;

  // Probe the remote for the chunks it already holds; ship the
  // complement.
  const remoteHas = new Set<string>();
  if (wantedHashes.length > 0) {
    const have = await remote.hasObjects(wantedHashes);
    for (const h of have) remoteHas.add(hex(h));
  }
  const missing = wantedHashes.filter((h) => !remoteHas.has(hex(h)));

  if (missing.length > 0) {
    const local = (function* () {
      for (const h of missing) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          h,
        );
        if (row === undefined) {
          throw new Error(`pushOnce: missing local blob ${hex(h)}`);
        }
        yield { hash: h, bytes: row.bytes };
      }
    })();
    const bytesStream = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
      pull(controller) {
        const next = local.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    await remote.pushObjects(bytesStream);
  }

  const entryStream = new ReadableStream<ChangeEntry>({
    start(controller) {
      for (const e of entries) controller.enqueue(e);
      controller.close();
    },
  });
  const response = await remote.push({ senderRev: localRev, changes: entryStream });

  // Cross-side invariant: the receiver must echo back at least
  // the rev we just claimed to push. A drift means the apply
  // path lost data, or a stale receiver is serving an old
  // snapshot. Tear down loudly rather than corrupt watermarks.
  assertAppliedPushRev(response.appliedPushRev, localRev);

  // Local pushRev advances to the rev we observed at the start of
  // this round. Anything written after that gets caught next tick.
  writeWatermark(db, "pushRev", localRev);
  return entries.length;
}

// One full tick: pull, then push. The order matters \u2014 pulling
// first lets the loopback-suppression in applyChanges absorb
// remote writes before we look at our own dirty set, so we don't
// re-push entries that just came in.
export async function tick(
  db: Database,
  remote: SyncRPC,
): Promise<{ pulled: number; pushed: number }> {
  const pulled = await pullOnce(db, remote);
  const pushed = await pushOnce(db, remote);
  return { pulled, pushed };
}
