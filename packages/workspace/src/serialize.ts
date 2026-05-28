/**
 * Per-Workspace serialization primitive.
 *
 * and VFS sync are not concurrency-safe"
 * finding): concurrent calls to Workspace.exec / writeFile / mkdir /
 * deleteFile can interleave their reads of pushSeq / pullSinceMs, race
 * mount-side writes against the VFS, and overwrite each other's
 * watermarks.  The fix is a single per-DO FIFO queue that every
 * mutating + sync entry point wraps its body in.
 *
 * The primitive is a tail-promise chain: each new task chains onto the
 * previous tail, then itself becomes the new tail.  Tasks are
 * guaranteed to run in enqueue order, with no overlap, and a task's
 * rejection does not poison subsequent tasks (we catch on the
 * stored-tail side, but rethrow to the caller).
 *
 * NOTE: this is not reentrant.  Calling serialize() from inside a task
 * on the same queue deadlocks.  The mutating methods on Workspace are
 * shallow enough that the rule "wrap once at the entry point" suffices.
 */

export interface Queue {
  /** The tail of the promise chain. Always present, never rejects. */
  tail: Promise<void>;
}

export function createQueue(): Queue {
  return { tail: Promise.resolve() };
}

/**
 * Run `fn` once the queue's current tail has settled. Returns a
 * promise that resolves with `fn`'s value or rejects with its error.
 * The queue's tail advances regardless of whether `fn` rejects, so a
 * single broken task does not block the rest of the queue.
 */
export function serialize<T>(queue: Queue, fn: () => T | Promise<T>): Promise<T> {
  // The chain we await on for ordering. We swallow its rejection here
  // so the next task in line still runs; the caller of the rejecting
  // task gets its own rejection via the returned promise below.
  const previous = queue.tail.catch(() => {});

  const run = previous.then(() => fn());

  // Update the queue's tail to a promise that resolves when this task
  // settles, regardless of outcome. We `.then(noop, noop)` rather than
  // `.catch()` because we want the chain to be a Promise<void>, not a
  // Promise<T | undefined>.
  queue.tail = run.then(noop, noop);

  return run;
}

function noop(): void { /* tail-chain swallows rejections */ }
