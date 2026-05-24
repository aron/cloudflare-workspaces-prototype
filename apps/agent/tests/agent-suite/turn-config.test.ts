/**
 * Turn configuration: system prompt, model selection, and
 * `providerOptions` for OpenAI ZDR.
 *
 *   - `getSystemPrompt()`   → the fixed system prompt from src/system-prompt.ts
 *   - `getModel()`          → OpenAI when `OPENAI_API_KEY` is set, else Workers AI
 *   - `beforeTurn()`        → returns `{ providerOptions }` for ZDR reasoning
 *
 * We introspect via `previewTurnConfig()`, a small RPC that runs the
 * same code paths Think would on a real turn but stops short of calling
 * the model. That keeps these tests fully offline.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

describe("Agent — turn configuration", () => {
  it("uses the fixed Cloudflare-focused system prompt", async () => {
    const agent = await freshAgent();
    const preview = await agent.previewTurnConfig();
    // Identity sentence and a couple of structural markers from
    // src/system-prompt.ts. Full prompt shape is covered by
    // tests/system-prompt.test.ts.
    expect(preview.systemPrompt).toMatch(/^You are an expert TypeScript developer/);
    expect(preview.systemPrompt).toMatch(/Cloudflare Workers/);
    expect(preview.systemPrompt).toMatch(/\nAvailable tools:\n/);
    expect(preview.systemPrompt).toMatch(/Current working directory: \/workspace$/);
  });

  it("threads ZDR-safe providerOptions through beforeTurn()", async () => {
    const agent = await freshAgent();
    const preview = await agent.previewTurnConfig();

    // OpenAI providers in ZDR orgs can't reference server-stored
    // reasoning by id. The old impl pinned store:false + the
    // encrypted-content include; the same posture must round-trip
    // through Think's TurnConfig.providerOptions.
    const openai = (preview.providerOptions as any)?.openai ?? {};
    expect(openai).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoningSummary: "auto"
    });
    // reasoningEffort defaults to "medium" when the env var is absent.
    expect(openai.reasoningEffort).toBe("medium");
  });

  it("the model selector is wired without crashing", async () => {
    const agent = await freshAgent();
    const preview = await agent.previewTurnConfig();
    // In production one of the two branches resolves (OpenAI or
    // Workers AI); in tests both fail because there's no AI binding
    // and no OPENAI_API_KEY. The contract here is just "the picker
    // runs and produces a boolean" — a real LLM smoke test belongs in
    // a deploy-time check, not a unit test.
    expect(typeof preview.modelDefined).toBe("boolean");
  });
});
