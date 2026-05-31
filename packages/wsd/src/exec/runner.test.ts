const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Database } = require("../../../../node_modules/@cloudflare/workspace-fs/dist/cjs/index.js");
const {
  SQLiteTestStorage,
} = require("../../../../node_modules/@cloudflare/workspace-fs/dist/cjs/testing.js");
const { Runner } = require("../../dist/exec/index.js");

type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; value: number };

function fixture(options: Record<string, unknown> = {}): {
  runner: any;
  dispose: () => void;
} {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  const runner = new Runner({ db, ...options });
  return {
    runner,
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
    assert.equal(stdout, "hello\n");
    assert.equal(stderr, "world\n");
    assert.equal(exit?.value, 3);
    // seq is monotonic per-id starting at 1.
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} > ${seqs[i - 1]}`);
    }
    assert.equal(seqs[0], 1);
  } finally {
    dispose();
  }
});

test("reusing a live id throws EEXEC_BUSY", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.5", { id: "busy" });
    assert.throws(
      () => runner.exec("echo nope", { id: "busy" }),
      (err: ExecError) => {
        assert.equal(err.code, "EEXEC_BUSY");
        return true;
      },
    );
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
    assert.ok(original.length >= 2);

    // Resume from seq=0 — should get everything.
    const full = await drain(runner.get("replay", { after: 0 }).events);
    assert.equal(full.length, original.length);
    assert.deepEqual(
      full.map((e) => e.seq),
      original.map((e) => e.seq),
    );

    // Resume from seq=1 — should skip the first event.
    const tail = await drain(runner.get("replay", { after: 1 }).events);
    assert.equal(tail.length, original.length - 1);
    assert.equal(tail[0].seq, original[1].seq);
  } finally {
    dispose();
  }
});

test("get() throws ENOENT for unknown id", async () => {
  const { runner, dispose } = fixture();
  try {
    assert.throws(
      () => runner.get("never"),
      (err: ExecError) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
    );
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
    assert.ok(exit !== undefined);
    // SIGTERM → 143 per the mapping in runner.ts.
    assert.equal(exit?.value, 143);
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
    assert.throws(
      () => runner.get("gone"),
      (err: ExecError) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
    );
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
    assert.ok(events.some((e) => e.name === "stdout"));
    // Replay should fail with ELOG_TRUNCATED. The throw happens
    // inside the pull callback when we walk the (gone) log rows.
    let caught: any;
    try {
      await drain(runner.get("evict", { after: 0 }).events);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== undefined, "replay should throw after eviction");
    assert.equal(caught.code, "ELOG_TRUNCATED");
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
    assert.throws(
      () => runner.get("ttl"),
      (err: ExecError) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
    );
  } finally {
    dispose();
  }
});
