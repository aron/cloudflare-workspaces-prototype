import type { Database } from "../storage.js";

// Stream chunk bytes by hash. The receiver collects these into the
// keyed map it uses when assembling files from ChangeEntry chunks.
// Missing hashes throw \u2014 the caller is supposed to have probed
// hasObjects() first to avoid asking for what the sender doesn't have.
//
// The push direction (DO \u2192 container) and the fetch direction
// (container \u2192 DO) both use this same shape; on the wire it is
// fetchObjects on one side and pushObjects on the other. Both names
// resolve to the same SQL.
export async function* pushObjects(
  db: Database,
  hashes: Uint8Array[],
): AsyncIterable<{ hash: Uint8Array; bytes: Uint8Array }> {
  for (const hash of hashes) {
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
      hash,
    );
    if (row === undefined) {
      throw new Error("pushObjects: missing blob for requested hash");
    }
    yield { hash, bytes: row.bytes };
  }
}
