/**
 * Tests for the in-flight exec tracking table used to recover
 * sandbox processes across DO restarts.
 *
 * Backed by node:sqlite via a minimal SqlStorage shim that mirrors
 * the workerd cursor surface. Same pattern as
 * @cloudflare/workspace's test shim.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ExecInflight,
  type SqlStorageLike,
} from "../src/exec-inflight.js";

/**
 * Tiny in-memory shim covering exactly the SQL the helper runs.
 * Avoids node:sqlite because vitest runs in workerd here, which
 * doesn't have it.
 */
function makeShim(): SqlStorageLike {
  type Row = { tool_call_id: string; process_id: string; started_at: number };
  let table: Map<string, Row> | null = null;
  return {
    exec(sql: string, ...b: unknown[]): Iterable<Record<string, unknown>> {
      const s = sql.trim();
      if (s.startsWith("CREATE TABLE")) {
        if (!table) table = new Map();
        return [];
      }
      if (!table) throw new Error("table not created");
      if (s.startsWith("INSERT INTO _exec_inflight")) {
        const [tid, pid, ts] = b as [string, string, number];
        table.set(tid, { tool_call_id: tid, process_id: pid, started_at: ts });
        return [];
      }
      if (s.startsWith("DELETE FROM _exec_inflight")) {
        const [tid] = b as [string];
        table.delete(tid);
        return [];
      }
      if (s.startsWith("SELECT") && s.includes("WHERE tool_call_id")) {
        const [tid] = b as [string];
        const row = table.get(tid);
        return row ? [row as Record<string, unknown>] : [];
      }
      if (s.startsWith("SELECT") && s.includes("ORDER BY started_at")) {
        return [...table.values()]
          .sort((a, b) => a.started_at - b.started_at) as Record<string, unknown>[];
      }
      throw new Error(`shim: unhandled SQL: ${s.slice(0, 60)}…`);
    },
  };
}

describe("ExecInflight", () => {
  let sql: SqlStorageLike;
  let inflight: ExecInflight;

  beforeEach(() => {
    sql = makeShim();
    inflight = new ExecInflight(sql);
    inflight.ensureTable();
  });

  it("ensureTable is idempotent", () => {
    expect(() => inflight.ensureTable()).not.toThrow();
    expect(() => inflight.ensureTable()).not.toThrow();
  });

  it("starts empty", () => {
    expect(inflight.list()).toEqual([]);
  });

  it("record / list round-trips", () => {
    inflight.record("call-1", "proc-1");
    inflight.record("call-2", "proc-2");
    const rows = inflight.list();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.toolCallId).sort()).toEqual(["call-1", "call-2"]);
    expect(rows.find(r => r.toolCallId === "call-1")?.processId).toBe("proc-1");
  });

  it("each row carries a startedAt timestamp", () => {
    const before = Date.now();
    inflight.record("call-1", "proc-1");
    const after = Date.now();
    const row = inflight.list()[0];
    expect(row.startedAt).toBeGreaterThanOrEqual(before);
    expect(row.startedAt).toBeLessThanOrEqual(after);
  });

  it("clear removes a single row", () => {
    inflight.record("call-1", "proc-1");
    inflight.record("call-2", "proc-2");
    inflight.clear("call-1");
    expect(inflight.list().map(r => r.toolCallId)).toEqual(["call-2"]);
  });

  it("clear is a no-op for unknown ids", () => {
    inflight.record("call-1", "proc-1");
    inflight.clear("does-not-exist");
    expect(inflight.list()).toHaveLength(1);
  });

  it("record is idempotent on the same toolCallId (last write wins)", () => {
    inflight.record("call-1", "proc-1");
    inflight.record("call-1", "proc-2");
    const rows = inflight.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].processId).toBe("proc-2");
  });

  it("get returns a single row by toolCallId", () => {
    inflight.record("call-1", "proc-1");
    const row = inflight.get("call-1");
    expect(row).toMatchObject({ toolCallId: "call-1", processId: "proc-1" });
  });

  it("get returns null for unknown ids", () => {
    expect(inflight.get("does-not-exist")).toBeNull();
  });
});
