/**
 * Worker-side helpers for the manifest-aware pull .
 *
 * The container ships a ManifestBulk: one record per dirty path with
 * `chunks: (hash, size)[]` per file and zero inline bytes. The DO
 * needs to:
 *
 *   1. work out which chunk hashes it doesn't already have locally
 *      (those become a single getBlobs() call to the container),
 *   2. assemble each file's bytes from the union of (just-fetched +
 *      already-local) blobs, verifying everything against its hash by
 *      construction \u2014 the lookup key IS the hash.
 *
 * Both halves are pure and testable in isolation: pass in a manifest
 * and a (hash -> bytes | null) lookup, get back the missing-hashes
 * list and the per-path assembled bytes.
 */

import type { ManifestBulk, ManifestChange } from "./shared/index.js";

/** Returns the deduped union of chunk hashes in a manifest bulk. */
export function chunkHashUnion(bulk: ManifestBulk): Uint8Array[] {
  const seen = new Map<string, Uint8Array>();
  for (const c of bulk.changes) {
    if (c.op !== "upsert" || c.type !== "file" || !c.chunks) continue;
    for (const k of c.chunks) seen.set(hashKey(k.hash), k.hash);
  }
  return [...seen.values()];
}

/**
 * Assemble a single file's bytes from a (hash \u2192 bytes) lookup. Throws
 * if any chunk's hash isn't in the lookup. Used after `chunkHashUnion`
 * + `getBlobs(missing)` lands.
 */
export function assembleFileBytes(
  chunks: { hash: Uint8Array; size: number }[],
  lookup: (hash: Uint8Array) => Uint8Array | null,
): Uint8Array {
  const total = chunks.reduce((n, k) => n + k.size, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const k of chunks) {
    const bytes = lookup(k.hash);
    if (!bytes) throw new Error(`assembleFileBytes: missing bytes for hash ${hexOf(k.hash)}`);
    if (bytes.length !== k.size) {
      throw new Error(`assembleFileBytes: hash ${hexOf(k.hash)} reports size ${k.size} but bytes are ${bytes.length}`);
    }
    out.set(bytes, off);
    off += k.size;
  }
  return out;
}

/** Stable string key for a chunk hash. latin1 round-trips bytes 1:1. */
export function hashKey(h: Uint8Array): string {
  return Buffer.from(h).toString("latin1");
}

function hexOf(h: Uint8Array): string {
  return Buffer.from(h).toString("hex");
}

/**
 * Convenience: given a manifest bulk and lookups for fetched + local
 * bytes, produce one `bytes` Uint8Array per file change. Returned map
 * is keyed by change.path. Non-file changes are absent from the map.
 *
 * Centralises the loop so callers don't have to recreate it; tests
 * exercise this directly.
 */
export function assembleAllFiles(
  bulk: ManifestBulk,
  lookup: (hash: Uint8Array) => Uint8Array | null,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const c of bulk.changes) {
    if (c.op !== "upsert" || c.type !== "file" || !c.chunks) continue;
    out.set(c.path, assembleFileBytes(c.chunks, lookup));
  }
  return out;
}

// Re-export for callers that want the change type without importing twice.
export type { ManifestChange };
