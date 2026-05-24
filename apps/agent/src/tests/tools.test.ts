/**
 * Slice 5 — `getTools()` returns a tool set gated by the active persona.
 *
 * Personas in `src/personas/` declare which tools beyond the common
 * file-ops set the model can call. The old `buildTools(persona)` helper
 * built that set inside the manual `onChatMessage` override; under
 * Think the same logic lives in `getTools()` so the agentic loop and
 * lifecycle hooks see exactly what we expect.
 *
 * We expose the active tool-name set via a small introspection RPC
 * (`activeToolNames()`) rather than driving a model turn — the contract
 * we care about is "which tools are visible to the LLM", and that's a
 * deterministic synchronous property of the persona.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { COMMON_TOOLS, lookupPersona, PERSONAS } from "../personas/index.js";
import type { Agent } from "../agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

describe("Agent — getTools()", () => {
  it("exposes COMMON_TOOLS for every persona", async () => {
    const agent = await freshAgent();
    const names = new Set(await agent.activeToolNames());
    for (const t of COMMON_TOOLS) {
      expect(names.has(t)).toBe(true);
    }
  });

  it("includes the active persona's extraTools and no others", async () => {
    const agent = await freshAgent();

    // Walk every persona, switch to it, and check the tool set
    // matches COMMON_TOOLS ∪ extraTools — no extras leak in, no
    // common tools drop out.
    for (const persona of PERSONAS) {
      const res = await agent.fetch("http://do/persona", {
        method: "POST",
        body: JSON.stringify({ id: persona.id }),
        headers: { "content-type": "application/json" }
      });
      expect(res.status).toBe(200);

      const got = new Set(await agent.activeToolNames());
      const expected = new Set([...COMMON_TOOLS, ...persona.extraTools]);
      expect(got).toEqual(expected);
    }
  });

  it("defaults to the cloudflare-worker persona's tool set on a fresh agent", async () => {
    const agent = await freshAgent();
    const got = new Set(await agent.activeToolNames());
    const expected = new Set([
      ...COMMON_TOOLS,
      ...lookupPersona(undefined).extraTools
    ]);
    expect(got).toEqual(expected);
  });
});
