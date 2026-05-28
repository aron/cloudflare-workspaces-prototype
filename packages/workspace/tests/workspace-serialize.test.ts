/**
 * \u2014 integration check that Workspace serializes its
 * mutating entry points.
 *
 * The unit tests in `serialize.test.ts` pin down the queue primitive;
 * these tests assert that Workspace.writeFile actually uses it. The
 * observable signal: a writable mount's `put()` records the order of
 * its concurrent calls. Without serialization, two writeFile() calls
 * to mount-backed paths overlap their puts. With serialization, the
 * second put doesn't start until the first one's promise settles.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Workspace } from "../src/workspace.ts";
import type { LazyMount, MountContext, MountFactory } from "../src/mounts/index.ts";
import { makeShimStorage } from "./sql-shim.ts";

function defer<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * A writable lazy mount that:
 *   - starts empty (list() returns no entries),
 *   - records the order of put() / delete() events,
 *   - lets the test gate when each put() resolves.
 *
 * We can ask it for a `gate` per call so the test orchestrates the
 * release order independently of the call order.
 */
function makeTrackedMount(): {
  factory: MountFactory;
  events: string[];
  release: (token: string) => void;
} {
  const events: string[] = [];
  const pending = new Map<string, () => void>();

  const mount: LazyMount = {
    kind: "tracked",
    writable: true,
    async list() { return []; },
    async fetch() { throw new Error("tracked-mount fetch not used in this test"); },
    async put(relPath, _bytes) {
      events.push(`put-start:${relPath}`);
      const d = defer<void>();
      pending.set(relPath, d.resolve);
      await d.promise;
      events.push(`put-end:${relPath}`);
    },
    async delete(relPath) {
      events.push(`delete:${relPath}`);
    },
  };

  const factory: MountFactory = (_ctx: MountContext) => mount;

  function release(relPath: string) {
    const resolve = pending.get(relPath);
    if (!resolve) throw new Error(`no pending put for ${relPath}`);
    pending.delete(relPath);
    resolve();
  }

  return { factory, events, release };
}

function makeWorkspace(mountFactory: MountFactory) {
  const storage = makeShimStorage();
  const ws = new Workspace({
    storage: storage as unknown as DurableObjectStorage,
    sandbox: {} as DurableObjectNamespace,
    sessionId: "test-session",
    mounts:   { "/workspace/m": mountFactory },
  });
  return { ws, storage };
}

describe("Workspace serializes mutating entry points", () => {
  test("two concurrent writeFile() calls to mount-backed paths run sequentially", async () => {
    const { factory, events, release } = makeTrackedMount();
    const { ws } = makeWorkspace(factory);

    // Fire both writes in the same microtask without awaiting.
    const a = ws.writeFile("/workspace/m/a.txt", new TextEncoder().encode("A"));
    const b = ws.writeFile("/workspace/m/b.txt", new TextEncoder().encode("B"));

    // Yield enough microtasks for ensureMountsIndexed() to resolve
    // and the first writeFile to enter the mount's put().
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Only the first put should have started; the second is still
    // queued behind the mutex.
    assert.deepEqual(events, ["put-start:a.txt"],
      `expected only a.txt's put in flight, got ${JSON.stringify(events)}`);

    release("a.txt");
    await a;

    // After a settles, b's put begins.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(events, ["put-start:a.txt", "put-end:a.txt", "put-start:b.txt"]);

    release("b.txt");
    await b;
    assert.deepEqual(events, [
      "put-start:a.txt", "put-end:a.txt",
      "put-start:b.txt", "put-end:b.txt",
    ]);
  });

  test("a throwing writeFile does not block subsequent writeFile calls", async () => {
    // Mount that rejects every put.
    const mount: LazyMount = {
      kind: "rejecting",
      writable: true,
      async list() { return []; },
      async fetch() { throw new Error("unused"); },
      async put(relPath) { throw new Error(`put failed: ${relPath}`); },
      async delete() { /* noop */ },
    };
    const { ws } = makeWorkspace(() => mount);

    const first  = ws.writeFile("/workspace/m/a.txt", new Uint8Array([1]));
    const second = ws.writeFile("/workspace/m/b.txt", new Uint8Array([2]));
    await assert.rejects(first,  /put failed: a\.txt/);
    await assert.rejects(second, /put failed: b\.txt/);
  });
});
