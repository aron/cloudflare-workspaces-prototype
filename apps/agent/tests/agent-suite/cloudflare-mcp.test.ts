/**
 * DO-level tests for the `cloudflare` tool's behavior when Cloudflare access is
 * NOT configured (no `MCP_TOKENS` KV binding in the test env). We assert the
 * tool degrades cleanly rather than throwing, and that `cloudflare` is exposed
 * in the tool set. The full OAuth connect/callback path needs a live MCP server
 * + KV and is out of scope for the in-process pool; the pure per-user token
 * routing, status rendering, and tool gating are covered by the unit tests
 * (tests/cloudflare-mcp.test.ts, tests/mcp-oauth-storage.test.ts).
 */
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

describe("Agent — cloudflare tool", () => {
  it("exposes the cloudflare tool", async () => {
    const agent = await freshAgent();
    const names = new Set(await agent.activeToolNames());
    expect(names.has("cloudflare")).toBe(true);
  });

  it("reports a clean error when MCP_TOKENS is not configured", async () => {
    // The test wrangler config has no MCP_TOKENS binding, so the tool should
    // return a friendly error object rather than throwing. invokeCloudflareTool
    // drains the generator to { yields, result }.
    const agent = await freshAgent();
    const { yields, result } = await agent.invokeCloudflareTool("status");
    // The terminal state must be YIELDED (the SDK's executeTool uses the last
    // yielded value as the tool output; a generator `return` is discarded).
    expect(yields).toHaveLength(1);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/not configured/i);
  });

  it("every command yields a terminal value (never null/undefined output)", async () => {
    // Regression for the async-generator bug where terminal states were
    // `return`ed instead of `yield`ed: the AI SDK drained the generator, saw
    // no yields, and resolved the tool with `undefined` — so the UI spun
    // forever and both status/connect surfaced as null. Each command must
    // yield at least once, and `result` (the last yield) must be defined.
    const agent = await freshAgent();
    for (const command of ["status", "connect", "disconnect"] as const) {
      const { yields, result } = await agent.invokeCloudflareTool(command);
      expect(yields.length).toBeGreaterThanOrEqual(1);
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      // With no MCP_TOKENS binding, every command short-circuits to the error.
      expect(typeof result.error).toBe("string");
    }
  });
});
