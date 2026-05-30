import type { Database } from "../storage.js";

// Watermarks owned by the DO. The container's appliedPushRev lives
// in-memory on the container side; we don't store it here.
//
// pushRev   — last DO-side rev successfully pushed to the container.
// fetchRev  — last container-side rev the DO has fetched and applied.
//
// initializeSchema() seeds both at 0 in _vfs_watermark. The schema
// table is the durability surface; readers and writers always go
// through this module so the SQL stays in one place.
export type WatermarkKey = "pushRev" | "fetchRev";

export function readWatermark(db: Database, key: WatermarkKey): number {
  return db.scalar<number>("SELECT v FROM _vfs_watermark WHERE k = ?", key) ?? 0;
}

export function writeWatermark(db: Database, key: WatermarkKey, value: number): void {
  db.run(
    "INSERT INTO _vfs_watermark (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    key,
    value,
  );
}

// The latest rev stamped on any DO-side mutation. coalesceChanges
// reads this implicitly via vfs_nodes.rev; the sync layer exposes it
// to callers that want to record "what cursor should I pass back as
// sinceRev next time".
export function currentRev(db: Database): number {
  return db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
}
