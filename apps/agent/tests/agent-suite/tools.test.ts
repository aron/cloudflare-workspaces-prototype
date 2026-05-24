/**
 * `getTools()` returns the single fixed tool set for the one-agent app.
 *
 * Personas are gone — there is no more `extraTools` gating. The agent
 * always exposes the same surface: the file-ops set, exec, web tools
 * (webSearch only when BRAVE_API_KEY is set), and the Worker tools.
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
  "read", "write", "edit",
  "listDirectory", "stat", "mkdir", "deleteFile",
  "findFiles", "grep",
  "exec",
  "webFetch", "webSearch",  // webSearch only because BRAVE_API_KEY is set in wrangler.test
  "worker_deploy", "worker_fetch",
  "gitClone", "gitCommit", "gitPush", "gitShare",
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
});
