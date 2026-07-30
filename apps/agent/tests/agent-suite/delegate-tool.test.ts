/**
 * Slice 4 — the `delegate` tool is present on Agent and the SubAgent
 * has the expected tool set and system-prompt shape.
 *
 * We do NOT drive a real LLM turn here (no AI binding in tests).
 * Instead we use introspection RPCs to verify structural contracts:
 *
 *   1. `delegate` appears in the parent Agent's tool list.
 *   2. SubAgent (reached via parent's spawnAndInspect RPC) exposes
 *      workspace tools but NOT `delegate` itself.
 *   3. SubAgent has a non-empty system prompt containing the
 *      worker-agent preamble.
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

// ── Parent (Agent) tool set ──────────────────────────────────────────

describe("Agent — delegate tool", () => {
  it("includes 'delegate' in the active tool set", async () => {
    const { stub } = await freshAgent();
    const names = new Set(await stub.activeToolNames());
    expect(names.has("delegate")).toBe(true);
  });

  it("delegate is in the tool set alongside file and exec tools", async () => {
    const { stub } = await freshAgent();
    const names = new Set(await stub.activeToolNames());
    // Core tools still present.
    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(true);
    // Sub-agent delegation.
    expect(names.has("delegate")).toBe(true);
  });
});

// ── SubAgent reachable through parent ───────────────────────────────

describe("SubAgent — reachable via parent", () => {
  it("spawns a sub-agent and gets its tool names (no delegate)", async () => {
    const { stub } = await freshAgent();
    // spawnAndInspect: spawn a child and return its activeSubAgentToolNames.
    const childToolNames = new Set(await stub.spawnAndInspectTools("inspector-1"));
    // Workspace tools are present.
    expect(childToolNames.has("read")).toBe(true);
    expect(childToolNames.has("write")).toBe(true);
    expect(childToolNames.has("exec")).toBe(true);
    expect(childToolNames.has("ls")).toBe(true);
    // delegate is absent — workers cannot delegate.
    expect(childToolNames.has("delegate")).toBe(false);
  });

  it("spawns a sub-agent and reads its worker system prompt", async () => {
    const { stub } = await freshAgent();
    const prompt = await stub.spawnAndReadWorkerPrompt("prompt-inspector");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("worker agent");
    expect(prompt).toContain("/workspace");
    // Must NOT contain the parent's TypeScript-developer identity.
    expect(prompt).not.toContain("Slack-style");
  });
});
