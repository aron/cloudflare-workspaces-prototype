/**
 * Pure-function tests for the warm-pool eviction and health predicates.
 *
 * `WarmPool` itself extends `DurableObject` and can only be constructed
 * with a real `DurableObjectState`, so the integration paths are covered
 * by manual deploys and the agent-suite. These tests pin the two pure
 * predicates the alarm and getContainer paths now rely on:
 *
 *   - `selectExpiredAssignments` is what the alarm calls to decide which
 *     assignments to drop. Idle eviction is the new behaviour added to
 *     stop the pool from leaking quota slots across hibernated agents.
 *   - `isAssignmentStateUsable` is the strict `healthy` check that
 *     replaced the looser `running || healthy` reuse predicate. The
 *     looser check is what made `getContainer` hand out UUIDs that would
 *     immediately 503 inside `Container.containerFetch`.
 */
import { describe, it, expect } from "vitest";
import {
  selectExpiredAssignments,
  isAssignmentStateUsable,
  type AssignmentRecord,
} from "../src/warm-pool.js";

function record(uuid: string, touchedAt: number): AssignmentRecord {
  return { uuid, touchedAt };
}

// ---- selectExpiredAssignments --------------------------------------------

describe("selectExpiredAssignments", () => {
  it("returns nothing when ttl is 0 (disabled)", () => {
    const assignments = new Map([
      ["s1", record("u1", 0)],
      ["s2", record("u2", 0)],
    ]);
    expect(selectExpiredAssignments(assignments, 1_000_000, 0)).toEqual([]);
  });

  it("returns nothing when ttl is negative (defensive: treated as disabled)", () => {
    const assignments = new Map([["s1", record("u1", 0)]]);
    expect(selectExpiredAssignments(assignments, 1_000, -1)).toEqual([]);
  });

  it("expires an assignment whose touchedAt is older than ttl", () => {
    // touchedAt=0, now=5000, ttl=3000 → idle is 5000ms, well past the cutoff.
    const assignments = new Map([["idle-sess", record("idle-uuid", 0)]]);
    const out = selectExpiredAssignments(assignments, 5_000, 3_000);
    expect(out).toEqual([{ sandboxId: "idle-sess", uuid: "idle-uuid", touchedAt: 0 }]);
  });

  it("keeps an assignment that is still inside the ttl window", () => {
    // touchedAt=900, now=1000, ttl=1000 → idle is 100ms.
    const assignments = new Map([["fresh-sess", record("fresh-uuid", 900)]]);
    expect(selectExpiredAssignments(assignments, 1_000, 1_000)).toEqual([]);
  });

  it("uses an inclusive cutoff: idle === ttl is expired", () => {
    // touchedAt=0, now=1000, ttl=1000 → idle equals ttl. Treat as expired
    // so the eviction sweep doesn't have to round up to bump it out.
    const assignments = new Map([["edge-sess", record("edge-uuid", 0)]]);
    const out = selectExpiredAssignments(assignments, 1_000, 1_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.sandboxId).toBe("edge-sess");
  });

  it("only returns the expired subset when assignments are mixed", () => {
    const assignments = new Map([
      ["old-1", record("old-uuid-1", 0)],
      ["fresh", record("fresh-uuid", 800)],
      ["old-2", record("old-uuid-2", 100)],
    ]);
    const out = selectExpiredAssignments(assignments, 1_000, 500);
    const ids = out.map((e) => e.sandboxId).sort();
    expect(ids).toEqual(["old-1", "old-2"]);
  });

  it("preserves the touchedAt snapshot so the caller can log idle time", () => {
    const assignments = new Map([["s", record("u", 42)]]);
    const out = selectExpiredAssignments(assignments, 10_000, 1_000);
    expect(out[0]?.touchedAt).toBe(42);
  });
});

// ---- isAssignmentStateUsable --------------------------------------------

describe("isAssignmentStateUsable", () => {
  it("accepts only `healthy` for reuse via getContainer", () => {
    // This is the central fix. `Container.containerFetch` only skips
    // `startAndWaitForPorts(port)` when state is `running && healthy`,
    // so handing back a `running`-but-not-healthy UUID guarantees the
    // next fetch trips the restart path — exactly where 503s come from
    // under instance-capacity pressure.
    expect(isAssignmentStateUsable("healthy")).toBe(true);
  });

  it("rejects `running` (not yet healthy — would trigger a re-start path)", () => {
    expect(isAssignmentStateUsable("running")).toBe(false);
  });

  it("rejects every other lifecycle state", () => {
    for (const status of ["stopping", "stopped", "stopped_with_code", "", "unknown"]) {
      expect(isAssignmentStateUsable(status)).toBe(false);
    }
  });
});
