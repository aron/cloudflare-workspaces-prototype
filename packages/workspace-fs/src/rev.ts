import type { Database } from "./storage.js";

// Atomic monotonic rev counter. Every FS mutation (mkdir, writeFile,
// rm, ...) calls incrementRev once per transaction and stamps the returned
// value into cf_vfs_nodes.rev. The sync layer reads cf_vfs_meta.rev as
// currentRev and consumes cf_vfs_changes.rev for tombstones.
//
// Must be called inside a transactionSync — the UPDATE and SELECT
// otherwise race with concurrent mutations. The DO single-writer model
// makes that unlikely in practice, but the contract is "wrap me".
export function incrementRev(db: Database): number {
  db.run("UPDATE cf_vfs_meta SET v = v + 1 WHERE k = 'rev'");
  const next = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = ?", "rev");
  if (next === undefined) {
    throw new Error("cf_vfs_meta.rev row missing; was initializeSchema run?");
  }
  return next;
}
