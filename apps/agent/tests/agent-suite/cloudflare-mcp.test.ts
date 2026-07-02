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
    // return a friendly error object rather than throwing.
    const agent = await freshAgent();
    const res = (await agent.invokeCloudflareTool("status")) as Record<
      string,
      unknown
    >;
    expect(typeof res.error).toBe("string");
    expect(res.error).toMatch(/not configured/i);
  });
});
