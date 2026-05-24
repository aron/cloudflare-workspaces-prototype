/**
 * Coverage for the pure pieces of `useMentionCandidates`. The hook itself
 * needs a DOM, which our vitest config doesn't ship; `filterCandidates`
 * carries the business logic and is plain string math.
 */
import { describe, it, expect } from "vitest";

import {
  filterCandidates,
  type MentionCandidate,
} from "../src/lib/useMentionCandidates.js";

// Mirrors the runtime ordering: the synthetic `agent` row first, then
// users in last-seen order.
const POOL: MentionCandidate[] = [
  { handle: "agent", label: "Agent", sub: "the room's assistant", kind: "agent" },
  { handle: "aron",  label: "Aron",  sub: "aron@x", kind: "user"  },
  { handle: "bea",   label: "Bea",   sub: "bea@x",  kind: "user"  },
];

describe("filterCandidates", () => {
  it("returns the full pool for an empty prefix", () => {
    expect(filterCandidates(POOL, "")).toEqual(POOL);
  });

  it("prefix-matches handles case-insensitively", () => {
    expect(filterCandidates(POOL, "ag").map(c => c.handle)).toEqual(["agent"]);
    expect(filterCandidates(POOL, "Ar").map(c => c.handle)).toEqual(["aron"]);
  });

  it("also matches against the label as a substring", () => {
    // `aron`'s handle doesn't share a prefix with `ro`, but its label does.
    expect(filterCandidates(POOL, "ro").map(c => c.handle)).toEqual(["aron"]);
  });

  it("puts the synthetic agent row first when no prefix is given", () => {
    expect(filterCandidates(POOL, "")[0]?.handle).toBe("agent");
  });

  it("respects the limit", () => {
    expect(filterCandidates(POOL, "", 2)).toHaveLength(2);
  });
});
