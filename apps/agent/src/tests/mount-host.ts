/**
 * Test-only Durable Object. Holds nothing of its own \u2014 it exists so tests
 * can call `runInDurableObject(stub, fn)` and get hold of the DO's real
 * SQLite-backed `DurableObjectState.storage`. The test body then constructs
 * a `Workspace` against that storage, exercises it, and returns whatever
 * it likes.
 *
 * Reusing the same DO id across two `runInDurableObject` calls exercises
 * the persisted-index path.
 */

import { DurableObject } from "cloudflare:workers";

export class MountHost extends DurableObject {
  // No methods. All test logic lives inside `runInDurableObject` callbacks.
}
