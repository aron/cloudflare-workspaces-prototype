/**
 * : per-workspace mutex used by Workspace.exec / writeFile /
 * mkdir / deleteFile to keep mutating + sync operations from
 * interleaving.
 *
 * The mutex is exposed as a free function `serialize(queue, fn)` plus
 * a `createQueue()` factory.  Each Workspace owns one queue; every
 * mutating method wraps its body in `serialize(this.queue, () => ...)`.
 *
 * Contract:
 *   1. FIFO  \u2014 tasks resolve in enqueue order, not race order.
 *   2. Non-overlap \u2014 task N+1 starts only after task N's returned
 *      promise has settled.
 *   3. Failure-resilient \u2014 a throwing or rejecting task does not
 *      block subsequent tasks; its rejection still propagates to its
 *      own caller.
 *   4. Resolves with the task's value, throws with the task's error.
 *   5. Reentrancy is NOT supported \u2014 calling serialize() from inside
 *      a serialized task on the same queue deadlocks (this is the
 *      same contract every classic async mutex provides; tests pin
 *      down that callers shouldn't do it, not that it's safe).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createQueue, serialize } from "../src/serialize.ts";

function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!:  (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("serialize / createQueue", () => {
  test("tasks run in FIFO order", async () => {
    const q = createQueue();
    const log: string[] = [];
    const a = serialize(q, async () => { log.push("a-start"); await Promise.resolve(); log.push("a-end"); });
    const b = serialize(q, async () => { log.push("b-start"); await Promise.resolve(); log.push("b-end"); });
    const c = serialize(q, async () => { log.push("c-start"); await Promise.resolve(); log.push("c-end"); });
    await Promise.all([a, b, c]);
    assert.deepEqual(log, ["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
  });

  test("a later task does NOT start until the earlier task's promise settles", async () => {
    const q = createQueue();
    const gate = defer<void>();
    let bStarted = false;

    const a = serialize(q, async () => { await gate.promise; });
    const b = serialize(q, async () => { bStarted = true; });

    // Yield several microtasks; b must still be waiting because a hasn't resolved.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(bStarted, false, "second task must wait until the first settles");

    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(bStarted, true);
  });

  test("a throwing task does not block subsequent tasks", async () => {
    const q = createQueue();
    const a = serialize(q, async () => { throw new Error("boom"); });
    const b = serialize(q, async () => "ok");
    await assert.rejects(a, /boom/);
    assert.equal(await b, "ok");
  });

  test("returns the task's value to its own caller", async () => {
    const q = createQueue();
    const out = await serialize(q, async () => 42);
    assert.equal(out, 42);
  });

  test("synchronous tasks still serialize correctly", async () => {
    const q = createQueue();
    const log: number[] = [];
    const a = serialize(q, () => { log.push(1); return 1; });
    const b = serialize(q, () => { log.push(2); return 2; });
    const c = serialize(q, () => { log.push(3); return 3; });
    const results = await Promise.all([a, b, c]);
    assert.deepEqual(log,     [1, 2, 3]);
    assert.deepEqual(results, [1, 2, 3]);
  });

  test("two queues run independently", async () => {
    const q1 = createQueue();
    const q2 = createQueue();
    const gate = defer<void>();
    const log: string[] = [];
    const a = serialize(q1, async () => { log.push("q1-a-start"); await gate.promise; log.push("q1-a-end"); });
    const b = serialize(q2, async () => { log.push("q2-b"); });
    await b;
    // q2-b completed even though q1-a is still blocked.
    assert.deepEqual(log, ["q1-a-start", "q2-b"]);
    gate.resolve();
    await a;
    assert.deepEqual(log, ["q1-a-start", "q2-b", "q1-a-end"]);
  });

  test("interleaved enqueues from inside a different queue's task still serialize per queue", async () => {
    // Models the real case: exec() holds q1 while doing something
    // that happens to call into another component that also enqueues
    // on a different queue. The second queue's FIFO is unaffected.
    const q1 = createQueue();
    const q2 = createQueue();
    const log: string[] = [];

    await serialize(q1, async () => {
      const a = serialize(q2, async () => { log.push("q2-a"); });
      const b = serialize(q2, async () => { log.push("q2-b"); });
      await Promise.all([a, b]);
      log.push("q1-done");
    });
    assert.deepEqual(log, ["q2-a", "q2-b", "q1-done"]);
  });
});
