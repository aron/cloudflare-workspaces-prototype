import type { ChangeEntry } from "@cloudflare/dofs";

import type { SyncRPC } from "./interface.js";
import { disposeRpcResult, disposeRpcResultAfterStream } from "./rpc-lifetime.js";

type MaybePromise<T> = T | PromiseLike<T>;

function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

function streamFromMaybePromise<T>(stream: MaybePromise<ReadableStream<T>>): ReadableStream<T> {
  if (!isPromiseLike(stream)) return stream;
  let readerPromise: Promise<ReadableStreamDefaultReader<T>> | undefined;
  let lockReleased = false;
  const getReader = () => {
    readerPromise ??= Promise.resolve(stream).then((resolved) => resolved.getReader());
    return readerPromise;
  };
  const releaseLock = (reader: ReadableStreamDefaultReader<T>) => {
    if (lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };
  return new ReadableStream<T>({
    async pull(controller) {
      let reader: ReadableStreamDefaultReader<T> | undefined;
      try {
        reader = await getReader();
        const { value, done } = await reader.read();
        if (done) {
          releaseLock(reader);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (reader !== undefined) releaseLock(reader);
        controller.error(error);
      }
    },
    async cancel(reason) {
      const reader = await getReader();
      try {
        await reader.cancel(reason);
      } finally {
        releaseLock(reader);
      }
    },
  });
}

function cloneChangeEntry(entry: ChangeEntry): ChangeEntry {
  switch (entry.kind) {
    case "file":
      return {
        kind: "file",
        rev: entry.rev,
        path: entry.path,
        mode: entry.mode,
        mtime: entry.mtime,
        size: entry.size,
        chunks: entry.chunks.map((chunk) => ({ hash: chunk.hash, size: chunk.size })),
      };
    case "dir":
      return {
        kind: "dir",
        rev: entry.rev,
        path: entry.path,
        mode: entry.mode,
        mtime: entry.mtime,
      };
    case "symlink":
      return {
        kind: "symlink",
        rev: entry.rev,
        path: entry.path,
        target: entry.target,
        mode: entry.mode,
        mtime: entry.mtime,
      };
    case "delete":
      return { kind: "delete", rev: entry.rev, path: entry.path };
  }
}

export function wrapSyncRpcResults(remote: SyncRPC): SyncRPC {
  return {
    async push(input) {
      const result = await remote.push(input);
      try {
        return { rev: result.rev, appliedPushRev: result.appliedPushRev };
      } finally {
        disposeRpcResult(result);
      }
    },

    async fetchChanges(input) {
      const result = await remote.fetchChanges(input);
      return {
        currentRev: result.currentRev,
        appliedPushRev: result.appliedPushRev,
        stream: disposeRpcResultAfterStream(result.stream, result),
      };
    },

    async watermarks() {
      const result = await remote.watermarks();
      try {
        return {
          currentRev: result.currentRev,
          pushRev: result.pushRev,
          fetchRev: result.fetchRev,
        };
      } finally {
        disposeRpcResult(result);
      }
    },

    async readEntry(path) {
      const result = await remote.readEntry(path);
      try {
        return result === null ? null : cloneChangeEntry(result);
      } finally {
        disposeRpcResult(result);
      }
    },

    async hasObjects(hashes) {
      const result = await remote.hasObjects(hashes);
      try {
        return Array.from(result);
      } finally {
        disposeRpcResult(result);
      }
    },

    fetchObjects(hashes) {
      return streamFromMaybePromise(remote.fetchObjects(hashes));
    },

    pushObjects(objects) {
      return remote.pushObjects(objects);
    },
  };
}
