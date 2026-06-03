import type { ChangeEntry } from "@cloudflare/dofs";
import { describe, expect, it, vi } from "vitest";
import { wrapSyncRpcResults } from "./client-sync-rpc.js";
import type { SyncRPC } from "./interface.js";

function disposable<T extends object>(value: T, dispose: () => void): T {
  Object.defineProperty(value, Symbol.dispose, {
    value: dispose,
    configurable: true,
  });
  return value;
}

function expectNoDisposer(value: object | null): void {
  expect((value as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]).toBeUndefined();
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      values.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return values;
}

function unwiredSyncRpc(overrides: Partial<SyncRPC>): SyncRPC {
  return {
    async push() {
      throw new Error("not wired");
    },
    async fetchChanges() {
      throw new Error("not wired");
    },
    async readEntry() {
      throw new Error("not wired");
    },
    async watermarks() {
      throw new Error("not wired");
    },
    async hasObjects() {
      throw new Error("not wired");
    },
    fetchObjects() {
      throw new Error("not wired");
    },
    async pushObjects() {
      throw new Error("not wired");
    },
    ...overrides,
  };
}

describe("wrapSyncRpcResults", () => {
  it("disposes scalar object results before returning plain data", async () => {
    const hasObjectsDispose = vi.fn();
    const pushDispose = vi.fn();
    const watermarksDispose = vi.fn();
    const readEntryDispose = vi.fn();
    const hash = new Uint8Array([1, 2, 3]);
    const entry: ChangeEntry = {
      kind: "file",
      rev: 7,
      path: "/a.txt",
      mode: 0o644,
      mtime: 123,
      size: 3,
      chunks: [{ hash, size: 3 }],
    };
    const sync = wrapSyncRpcResults(
      unwiredSyncRpc({
        async hasObjects() {
          return disposable([hash], hasObjectsDispose);
        },
        async push() {
          return disposable({ rev: 9, appliedPushRev: 8 }, pushDispose);
        },
        async watermarks() {
          return disposable({ currentRev: 3, pushRev: 2, fetchRev: 1 }, watermarksDispose);
        },
        async readEntry() {
          return disposable(entry, readEntryDispose);
        },
      }),
    );

    const have = await sync.hasObjects([hash]);
    const push = await sync.push({
      senderRev: 8,
      changes: new ReadableStream<ChangeEntry>({ start: (controller) => controller.close() }),
    });
    const watermarks = await sync.watermarks();
    const readEntry = await sync.readEntry("/a.txt");

    expect(have).toEqual([hash]);
    expect(push).toEqual({ rev: 9, appliedPushRev: 8 });
    expect(watermarks).toEqual({ currentRev: 3, pushRev: 2, fetchRev: 1 });
    expect(readEntry).toEqual(entry);
    expectNoDisposer(have);
    expectNoDisposer(push);
    expectNoDisposer(watermarks);
    expectNoDisposer(readEntry);
    expect(hasObjectsDispose).toHaveBeenCalledOnce();
    expect(pushDispose).toHaveBeenCalledOnce();
    expect(watermarksDispose).toHaveBeenCalledOnce();
    expect(readEntryDispose).toHaveBeenCalledOnce();
  });

  it("disposes fetchChanges results when the returned stream is drained", async () => {
    const dispose = vi.fn();
    const entry: ChangeEntry = { kind: "dir", rev: 1, path: "/src", mode: 0o755, mtime: 10 };
    const sync = wrapSyncRpcResults(
      unwiredSyncRpc({
        async fetchChanges() {
          return disposable(
            {
              currentRev: 1,
              appliedPushRev: 0,
              stream: new ReadableStream<ChangeEntry>({
                start(controller) {
                  controller.enqueue(entry);
                  controller.close();
                },
              }),
            },
            dispose,
          );
        },
      }),
    );

    const result = await sync.fetchChanges({ sinceRev: 0 });
    expect(result.currentRev).toBe(1);
    expect(result.appliedPushRev).toBe(0);
    expect(dispose).not.toHaveBeenCalled();

    await expect(collect(result.stream)).resolves.toEqual([entry]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes fetchChanges results when the returned stream is cancelled", async () => {
    const dispose = vi.fn();
    const sync = wrapSyncRpcResults(
      unwiredSyncRpc({
        async fetchChanges() {
          return disposable(
            {
              currentRev: 1,
              appliedPushRev: 0,
              stream: new ReadableStream<ChangeEntry>({
                pull(controller) {
                  controller.enqueue({ kind: "dir", rev: 1, path: "/src", mode: 0o755, mtime: 10 });
                },
              }),
            },
            dispose,
          );
        },
      }),
    );

    const result = await sync.fetchChanges({ sinceRev: 0 });
    await result.stream.cancel();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not dispose pure stream results at call time", async () => {
    const stream = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
      start(controller) {
        controller.close();
      },
    });
    const sync = wrapSyncRpcResults(
      unwiredSyncRpc({
        fetchObjects() {
          return stream;
        },
      }),
    );

    expect(sync.fetchObjects([])).toBe(stream);
  });

  it("releases delayed stream locks when stream reads fail", async () => {
    const error = new Error("boom");
    const inner = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
      pull() {
        throw error;
      },
    });
    const sync = wrapSyncRpcResults(
      unwiredSyncRpc({
        fetchObjects() {
          return Promise.resolve(inner) as unknown as ReadableStream<{
            hash: Uint8Array;
            bytes: Uint8Array;
          }>;
        },
      }),
    );

    const outerReader = sync.fetchObjects([]).getReader();
    await expect(outerReader.read()).rejects.toThrow("boom");
    outerReader.releaseLock();

    const innerReader = inner.getReader();
    innerReader.releaseLock();
  });
});
