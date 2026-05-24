/**
 * Slice 3 — top-level `Agent` can spawn a `SubAgent` facet.
 *
 * Our agent is single-threaded by design (one DO per Slack-style chat),
 * but we want the option to fan work out to a sub-agent — research,
 * compilation, a longer-horizon side task — without abandoning the
 * conversation. Think's `subAgent()` is the framework primitive that
 * makes that possible: the child runs as a facet of the parent DO with
 * its own SQLite, message history, and fiber recovery, and the parent
 * gets a typed RPC stub back.
 *
 * These tests pin down two contracts:
 *   1. `Agent` can call `subAgent(SubAgent, name)` and reach the child via RPC.
 *   2. The child can resolve its parent via `parentAgent(Agent)` for round-tripping.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<{
  stub: DurableObjectStub<Agent>;
  name: string;
}> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  const stub = await getAgentByName(env.Agent, name);
  return { stub, name };
}

describe("Agent — sub-agent spawning", () => {
  it("can spawn a SubAgent facet and reach it via RPC", async () => {
    const { stub } = await freshAgent();

    // The parent spawns a child by name, runs a sanity RPC against it,
    // and reports the round-tripped value back to the test. If the
    // sub-agent capability is wired correctly the child responds with
    // its own DO name.
    const echoed = await stub.spawnAndPing("worker-1");
    expect(echoed).toBe("worker-1");
  });

  it("the child can resolve its parent via parentAgent()", async () => {
    const { stub, name } = await freshAgent();

    // Round-trip the parent name through the child: parent spawns
    // child, child resolves parent stub, parent reports its own name.
    // Proves the parent/child link in both directions.
    const parentName = await stub.spawnAndAskParentName("worker-2");
    expect(parentName).toBe(name);
  });
});
