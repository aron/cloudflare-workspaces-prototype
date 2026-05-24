/**
 * Slice 1 — the migrated `Agent` and `SubAgent` are `Think` subclasses.
 *
 * The deep behaviour (chatRecovery fibers, maxSteps, persona persistence,
 * sub-agent spawning) is covered in dedicated behavioural test files.
 * This file just pins down the class shape — the bare minimum that
 * proves the migration's structural goal: both classes inherit from
 * Think so they get its agentic loop, session storage, and fiber-backed
 * durable execution.
 */

import { describe, expect, it } from "vitest";
import { Think } from "@cloudflare/think";
import { Agent, SubAgent } from "../agent.js";

describe("class hierarchy", () => {
  it("Agent extends Think", () => {
    expect(Agent.prototype).toBeInstanceOf(Think);
  });

  it("SubAgent extends Think", () => {
    // Sub-agents need to be Think DOs so a parent can `chat()` against
    // them and get the same streaming RPC contract.
    expect(SubAgent.prototype).toBeInstanceOf(Think);
  });
});
