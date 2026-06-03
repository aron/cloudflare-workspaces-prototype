import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { beforeAll, describe, expect, test } from "vitest";

import { Runner } from "./runner.js";

type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; value: number };

function fixture(options: Record<string, unknown> = {}): {
  runner: InstanceType<typeof Runner>;
  db: Database;
  dispose: () => void;
} {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  const runner = new Runner({ db, ...options });
  return {
    runner,
    db,
    dispose: () => {
      runner.disposeAll();
      storage.close?.();
    },
  };
}

async function drain(stream: ReadableStream<ExecEvent>): Promise<ExecEvent[]> {
  const events: ExecEvent[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

test("exec captures stdout and propagates exit code", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("echo hello && echo world >&2 && exit 3");
    const events = await drain(handle.events);
    const stdout = events
      .filter((e) => e.name === "stdout")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const stderr = events
      .filter((e) => e.name === "stderr")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const exit = events.find((e) => e.name === "exit");
    expect(stdout).toBe("hello\n");
    expect(stderr).toBe("world\n");
    expect(exit?.value).toBe(3);
    // seq is monotonic per-id starting at 1.
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBeTruthy();
    }
    expect(seqs[0]).toBe(1);
  } finally {
    dispose();
  }
});

test("reusing a live id throws EEXEC_BUSY", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.5", { id: "busy" });
    try {
      runner.exec("echo nope", { id: "busy" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("EEXEC_BUSY");
    }
    await drain(handle.events);
  } finally {
    dispose();
  }
});

test("get() replays a completed exec by seq", async () => {
  const { runner, dispose } = fixture();
  try {
    const first = runner.exec("printf 'a\\nb\\nc\\n'", { id: "replay" });
    const original = await drain(first.events);
    expect(original.length >= 2).toBeTruthy();

    // Resume from seq=0 — should get everything.
    const full = await drain(runner.get("replay", { after: 0 }).events);
    expect(full.length).toBe(original.length);
    expect(full.map((e) => e.seq)).toEqual(original.map((e) => e.seq));

    // Resume from seq=1 — should skip the first event.
    const tail = await drain(runner.get("replay", { after: 1 }).events);
    expect(tail.length).toBe(original.length - 1);
    expect(tail[0].seq).toBe(original[1].seq);
  } finally {
    dispose();
  }
});

test("get() throws ENOENT for unknown id", async () => {
  const { runner, dispose } = fixture();
  try {
    try {
      runner.get("never");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("kill() terminates a running exec", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 30", { id: "killme" });
    runner.kill("killme", "SIGTERM");
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    // SIGTERM → 143 per the mapping in runner.ts.
    expect(exit?.value).toBe(143);
  } finally {
    dispose();
  }
});

test("exec times out at timeoutMs and exits 143", async () => {
  const { runner, dispose } = fixture();
  try {
    // 100ms is short enough for a fast test but long enough to
    // exclude any plausible spawn-jitter false positive.
    const handle = runner.exec("sleep 30", { id: "slow", timeoutMs: 100 });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    // SIGTERM → 143 per mapExitCode.
    expect(exit?.value).toBe(143);
  } finally {
    dispose();
  }
});

test("exec uses defaultTimeoutMs from the runner when no per-call value", async () => {
  const { runner, dispose } = fixture({ defaultTimeoutMs: 100 });
  try {
    const handle = runner.exec("sleep 30", { id: "slow" });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    expect(exit?.value).toBe(143);
  } finally {
    dispose();
  }
});

test("per-call timeoutMs overrides the runner default", async () => {
  // Runner default is 5s; per-call 100ms must win.
  const { runner, dispose } = fixture({ defaultTimeoutMs: 5_000 });
  try {
    const start = Date.now();
    const handle = runner.exec("sleep 30", { id: "override", timeoutMs: 100 });
    await drain(handle.events);
    expect(Date.now() - start < 2_000).toBeTruthy();
  } finally {
    dispose();
  }
});

test("timeoutMs: 0 disables the timeout", async () => {
  const { runner, dispose } = fixture({ defaultTimeoutMs: 50 });
  try {
    // The 50ms default would kill this; 0 must override to disable.
    const handle = runner.exec("echo hi", { id: "noto", timeoutMs: 0 });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit?.value).toBe(0);
  } finally {
    dispose();
  }
});

test("dispose() removes the log and subsequent get() throws ENOENT", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("echo done", { id: "gone" });
    await drain(handle.events);
    runner.dispose("gone");
    try {
      runner.get("gone");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("log eviction past maxBytes yields ELOG_TRUNCATED on replay", async () => {
  // Tight cap forces an evict on the first kilobyte of stdout.
  const { runner, dispose } = fixture({ logMaxBytes: 512 });
  try {
    const handle = runner.exec(
      // Generate 2 KiB of output — well over the cap.
      "head -c 2048 /dev/urandom | base64",
      { id: "evict" },
    );
    const events = await drain(handle.events);
    // Live stream still saw events (eviction doesn't gate live).
    expect(events.some((e) => e.name === "stdout")).toBeTruthy();
    // Replay should fail with ELOG_TRUNCATED. The throw happens
    // inside the pull callback when we walk the (gone) log rows.
    let caught: unknown;
    try {
      await drain(runner.get("evict", { after: 0 }).events);
    } catch (err) {
      caught = err;
    }
    expect(caught !== undefined).toBeTruthy();
    expect((caught as { code?: string }).code).toBe("ELOG_TRUNCATED");
  } finally {
    dispose();
  }
});

test("retention sweep evicts records past TTL", async () => {
  let nowMs = 1_000_000;
  const { runner, dispose } = fixture({
    now: () => nowMs,
    retentionMs: 100,
  });
  try {
    const handle = runner.exec("echo bye", { id: "ttl" });
    await drain(handle.events);
    // Advance past the TTL window and sweep.
    nowMs += 500;
    runner.sweep();
    try {
      runner.get("ttl");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("exit-event surfaces an error on the subscriber when setExit throws", async () => {
  // Simulate the log row vanishing between exec start and child exit.
  // Previously this swallowed the exit event and the subscriber's
  // stream hung forever. Now the subscriber should see its stream
  // error out instead.
  const { runner, db, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.1", { id: "setexit-throws" });
    // Drop the meta row out from under the runner. setExit() will
    // throw 'setExit after dispose' when the child exits.
    db.run("DELETE FROM wsd_exec_meta WHERE exec_id = ?", "setexit-throws");
    db.run("DELETE FROM wsd_exec_log WHERE exec_id = ?", "setexit-throws");

    let caught: unknown;
    const reader = handle.events.getReader();
    try {
      while (true) {
        try {
          const { done } = await reader.read();
          if (done) break;
        } catch (err) {
          caught = err;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    expect(caught instanceof Error).toBeTruthy();
    expect((caught as Error).message).toMatch(/setExit after dispose/);
  } finally {
    dispose();
  }
});
