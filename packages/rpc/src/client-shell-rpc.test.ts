import { describe, expect, it, vi } from "vitest";
import { wrapShellRpcResults } from "./client-shell-rpc.js";
import type { ExecEvent, ShellRPC } from "./interface.js";

function disposable<T extends object>(value: T, dispose: () => void): T {
  Object.defineProperty(value, Symbol.dispose, {
    value: dispose,
    configurable: true,
  });
  return value;
}

function expectNoDisposer(value: object): void {
  expect((value as { [Symbol.dispose]?: unknown })[Symbol.dispose]).toBeUndefined();
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

function eventStream(): ReadableStream<ExecEvent> {
  return new ReadableStream<ExecEvent>({
    start(controller) {
      controller.enqueue({ id: "exec-1", seq: 1, name: "exit", value: 0 });
      controller.close();
    },
  });
}

function unwiredShellRpc(overrides: Partial<ShellRPC>): ShellRPC {
  return {
    async exec() {
      throw new Error("not wired");
    },
    async getExec() {
      throw new Error("not wired");
    },
    async killExec() {
      throw new Error("not wired");
    },
    async disposeExec() {
      throw new Error("not wired");
    },
    ...overrides,
  };
}

describe("wrapShellRpcResults", () => {
  it("disposes exec results when the event stream is drained", async () => {
    const dispose = vi.fn();
    const shell = wrapShellRpcResults(
      unwiredShellRpc({
        async exec() {
          return disposable({ id: "exec-1", events: eventStream() }, dispose);
        },
      }),
    );

    const handle = await shell.exec({ command: "echo hi" });
    expectNoDisposer(handle);
    expect(dispose).not.toHaveBeenCalled();

    await expect(collect(handle.events)).resolves.toEqual([
      { id: "exec-1", seq: 1, name: "exit", value: 0 },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes getExec results when the event stream is cancelled", async () => {
    const dispose = vi.fn();
    const shell = wrapShellRpcResults(
      unwiredShellRpc({
        async getExec() {
          return disposable({ id: "exec-1", events: eventStream() }, dispose);
        },
      }),
    );

    const handle = await shell.getExec({ id: "exec-1" });
    await handle.events.cancel();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
