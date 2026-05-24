/**
 * End-to-end: the agent enumerates skills from the R2-backed SKILLS mount
 * and renders them in the system prompt's <available_skills> block.
 *
 * Pool-workers provisions a local R2 bucket for the SKILLS binding, so
 * we can seed real objects and observe the agent's prompt change.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Agent } from "../../src/agent.js";

const enc = new TextEncoder();

const SKILL_OK = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody.\n`;

async function seedSkill(name: string, body: string) {
  await env.SKILLS.put(`${name}/SKILL.md`, enc.encode(body));
}

async function clearSkills() {
  // Defensive: list everything and remove. Pool-workers gives each
  // test file a fresh R2 namespace, but tests within this file share
  // it, so isolate per-test by clearing first.
  const list = await env.SKILLS.list();
  await Promise.all(list.objects.map(o => env.SKILLS.delete(o.key)));
}

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  // Use a random name so each test gets a fresh DO with a fresh
  // construction (the skill index is loaded in the constructor).
  return getAgentByName(env.Agent, `agent-${Math.random().toString(36).slice(2)}`);
}

describe("Agent — skills in system prompt", () => {
  it("renders the <available_skills> block when the bucket has skills", async () => {
    await clearSkills();
    await seedSkill("cloudflare-workers", SKILL_OK("cloudflare-workers", "Workers fundamentals."));
    await seedSkill("agents-sdk",         SKILL_OK("agents-sdk",         "Agents SDK patterns."));

    const agent  = await freshAgent();
    const prev   = await agent.previewTurnConfig();
    const prompt = prev.systemPrompt;

    expect(prompt).toMatch(/<available_skills>/);
    expect(prompt).toMatch(/<name>agents-sdk<\/name>/);
    expect(prompt).toMatch(/<description>Agents SDK patterns\.<\/description>/);
    expect(prompt).toMatch(
      /<location>\/workspace\/\.agents\/skills\/cloudflare-workers\/SKILL\.md<\/location>/,
    );
    expect(prompt).toMatch(/<name>cloudflare-workers<\/name>/);
  });

  it("omits <available_skills> when the bucket is empty", async () => {
    await clearSkills();
    const agent  = await freshAgent();
    const prompt = (await agent.previewTurnConfig()).systemPrompt;
    expect(prompt).not.toMatch(/<available_skills>/);
  });

  it("excludes skills with disable-model-invocation: true from the prompt", async () => {
    await clearSkills();
    await seedSkill("visible", SKILL_OK("visible", "Visible."));
    await seedSkill(
      "hidden",
      "---\nname: hidden\ndescription: Hidden one.\ndisable-model-invocation: true\n---\nbody",
    );

    const agent  = await freshAgent();
    const prompt = (await agent.previewTurnConfig()).systemPrompt;

    expect(prompt).toMatch(/<name>visible<\/name>/);
    expect(prompt).not.toMatch(/<name>hidden<\/name>/);
  });
});
