/**
 * `getTools()` returns the single fixed tool set for the one-agent app.
 *
 * Personas are gone — there is no more `extraTools` gating. The agent
 * always exposes the same surface: the package's `createAITools` set,
 * the web tools (websearch only when BRAVE_API_KEY is set), and
 * delegate.
 *
 * We expose the active tool-name set via a small introspection RPC
 * (`activeToolNames()`) rather than driving a model turn — the contract
 * we care about is "which tools are visible to the LLM", and that's a
 * deterministic synchronous property of the agent.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

const EXPECTED_TOOLS = [
  // From @cloudflare/computer/tools. No `publish`: the test config has
  // no R2 credentials, so the workspace is built without an assets
  // client.
  "read", "ls", "write", "edit",
  "exec",  // takes an optional backend: 'shell' | 'container'; 'shell' includes a built-in git command
  "webfetch", "websearch",  // websearch only because BRAVE_API_KEY is set in wrangler.test
  "delegate",  // spawn a named sub-agent that shares this workspace
  "schedule",  // create/list/cancel one-off or recurring tasks
  "cloudflare",  // per-user Cloudflare MCP access (connect/status/disconnect)
] as const;

describe("Agent — getTools()", () => {
  it("exposes the single fixed tool set", async () => {
    const agent = await freshAgent();
    const names = new Set(await agent.activeToolNames());
    expect(names).toEqual(new Set<string>(EXPECTED_TOOLS));
  });

  it("does not include the deprecated 'run' WASM tool", async () => {
    const agent = await freshAgent();
    const names = new Set(await agent.activeToolNames());
    expect(names.has("run")).toBe(false);
  });

  it("no longer hand-rolls tools the package provides", async () => {
    const agent = await freshAgent();
    const names = new Set(await agent.activeToolNames());
    for (const retired of ["apply_patch", "stat", "mkdir", "rm", "find", "grep"]) {
      expect(names.has(retired)).toBe(false);
    }
  });
});
