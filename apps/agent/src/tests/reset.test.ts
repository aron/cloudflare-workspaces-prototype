/**
 * Slice 4 — `/reset` clears the conversation history.
 *
 * The old implementation routed through `AIChatAgent.saveMessages([])`,
 * which doesn't exist on Think. The migration must switch to
 * `clearMessages()` (Think's public clear-history API) while keeping the
 * HTTP contract — POST /reset returns `{cleared: true}` and subsequent
 * GET /messages reports zero messages.
 *
 * We seed history via Think's `saveMessages(...)` rather than driving a
 * real model turn — tests deliberately don't talk to the model. That
 * keeps the assertion focused on the reset path itself.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

async function getMessageCount(
  agent: DurableObjectStub<Agent>
): Promise<number> {
  const res = await agent.fetch("http://do/messages");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { count: number };
  return body.count;
}

describe("Agent — /reset", () => {
  it("clears messages and reports them gone via /messages", async () => {
    const agent = await freshAgent();

    // Seed one user message so the reset has something to clear.
    // `seedUserMessage` is a small testing-only RPC on Agent that
    // appends a message via Think's session — bypassing the model.
    await agent.seedUserMessage("hello");
    expect(await getMessageCount(agent)).toBe(1);

    const res = await agent.fetch("http://do/reset", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: boolean };
    expect(body.cleared).toBe(true);

    expect(await getMessageCount(agent)).toBe(0);
  });
});
