/**
 * Slice 2 — persona persistence via Think's `configure()`/`getConfig()`.
 *
 * The old implementation hand-rolled a `_agent_state` SQL table. Migrating
 * to Think gives us a typed config store backed by Session's SQLite, which
 * survives hibernation and restarts without any per-agent schema setup.
 *
 * These tests pin down the contract: the persona id round-trips through
 * SQLite, defaults to the cloudflare-worker persona, and rejects unknown
 * ids without overwriting the current value.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, PERSONAS } from "../../src/personas/index.js";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

async function getPersonaId(agent: DurableObjectStub<Agent>): Promise<string> {
  const res = await agent.fetch("http://do/persona");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { current: { id: string } };
  return body.current.id;
}

async function setPersonaId(
  agent: DurableObjectStub<Agent>,
  id: string
): Promise<Response> {
  return agent.fetch("http://do/persona", {
    method: "POST",
    body: JSON.stringify({ id }),
    headers: { "content-type": "application/json" }
  });
}

describe("Agent — persona", () => {
  it("defaults to the cloudflare-worker persona for a fresh agent", async () => {
    const agent = await freshAgent();
    const id = await getPersonaId(agent);
    expect(id).toBe(DEFAULT_PERSONA.id);
  });

  it("persists a persona change across DO RPC calls", async () => {
    const agent = await freshAgent();

    // Pick a non-default persona to make the assertion meaningful.
    const target = PERSONAS.find((p) => p.id !== DEFAULT_PERSONA.id);
    expect(target).toBeDefined();

    const res = await setPersonaId(agent, target!.id);
    expect(res.status).toBe(200);

    const id = await getPersonaId(agent);
    expect(id).toBe(target!.id);
  });

  it("rejects unknown persona ids without overwriting the current value", async () => {
    const agent = await freshAgent();

    const res = await setPersonaId(agent, "no-such-persona");
    expect(res.status).toBe(400);

    const id = await getPersonaId(agent);
    expect(id).toBe(DEFAULT_PERSONA.id);
  });
});
