/**
 * Pure-function tests for src/system-prompt.ts. No DOs, no bindings.
 *
 * The system prompt is modelled on pi's `buildSystemPrompt` shape so the
 * structure stays familiar:
 *   identity → workspace → tools → custom-tools hedge → guidelines →
 *   skills preamble + <available_skills> XML → date/cwd footer
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type Skill } from "../src/system-prompt.js";

describe("buildSystemPrompt — identity & shape", () => {
  it("opens with the TypeScript / Cloudflare / Agents / Sandbox identity sentence", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt.startsWith("You are an expert TypeScript developer")).toBe(true);
    expect(prompt).toMatch(/Cloudflare Workers/);
    expect(prompt).toMatch(/Agents SDK/);
    expect(prompt).toMatch(/Sandbox SDK/);
  });

  it("ends with the current working directory line", () => {
    const prompt = buildSystemPrompt({ cwd: "/workspace" });
    expect(prompt.trimEnd().endsWith("Current working directory: /workspace")).toBe(true);
  });

  it("includes a YYYY-MM-DD current date line just before the cwd line", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: /);
  });

  it("includes the workspace + worker-egress reminder", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/All files live under \/workspace/);
    expect(prompt).toMatch(/build container has network access/);
    expect(prompt).toMatch(/deployed Worker does not/);
  });
});

describe("buildSystemPrompt — tool list", () => {
  it("lists every tool the agent registers, each on its own bullet", () => {
    const prompt = buildSystemPrompt({});
    const expected = [
      "read", "write", "edit",
      "listDirectory", "stat", "mkdir", "deleteFile",
      "findFiles", "grep",
      "exec",
      "webFetch", "webSearch",
      "worker_deploy", "worker_fetch",
    ];
    for (const name of expected) {
      expect(prompt).toMatch(new RegExp(`\\n- ${name}: `));
    }
  });

  it("includes the custom-tools hedge sentence after the tool list", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/In addition to the tools above, you may have access to other custom tools/);
  });
});

describe("buildSystemPrompt — guidelines", () => {
  it("includes the file-exploration preference and always-on bullets", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/Prefer grep \/ findFiles \/ listDirectory over exec/);
    expect(prompt).toMatch(/- Be concise/);
    expect(prompt).toMatch(/- Show file paths clearly/);
    expect(prompt).toMatch(/Use worker_deploy \+ worker_fetch to test Workers, not exec/);
  });
});

describe("buildSystemPrompt — skills", () => {
  const skills: Skill[] = [
    {
      name: "cloudflare-workers",
      description: "Cloudflare Workers fundamentals, bindings, wrangler config.",
      location: "/workspace/.agents/skills/cloudflare-workers/SKILL.md",
    },
    {
      name: "agents-sdk",
      description: "Cloudflare Agents SDK patterns for stateful Durable-Object agents.",
      location: "/workspace/.agents/skills/agents-sdk/SKILL.md",
    },
  ];

  it("omits the skills section entirely when no skills are provided", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toMatch(/<available_skills>/);
    expect(prompt).not.toMatch(/The following skills provide/);
  });

  it("omits the skills section when the skills array is empty", () => {
    const prompt = buildSystemPrompt({ skills: [] });
    expect(prompt).not.toMatch(/<available_skills>/);
  });

  it("includes the pi-style preamble before <available_skills>", () => {
    const prompt = buildSystemPrompt({ skills });
    expect(prompt).toMatch(/The following skills provide specialized instructions/);
    expect(prompt).toMatch(/Use the read tool to load a skill's file/);
    expect(prompt).toMatch(/resolve it against the skill directory/);
  });

  it("emits one <skill> block per skill with name/description/location in order", () => {
    const prompt = buildSystemPrompt({ skills });
    const block = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/<name>cloudflare-workers<\/name>[\s\S]*<name>agents-sdk<\/name>/);
    expect(block).toMatch(/<description>Cloudflare Workers fundamentals[^<]+<\/description>/);
    expect(block).toMatch(/<location>\/workspace\/\.agents\/skills\/cloudflare-workers\/SKILL\.md<\/location>/);
  });

  it("escapes XML-significant characters in name/description/location", () => {
    const prompt = buildSystemPrompt({
      skills: [{
        name: "edge-cases",
        description: 'has <angle> & "quote" \'apos\' chars',
        location: "/workspace/.agents/skills/edge-cases/SKILL.md",
      }],
    });
    expect(prompt).toMatch(/&lt;angle&gt; &amp; &quot;quote&quot; &apos;apos&apos;/);
    expect(prompt).not.toMatch(/<angle>/);
  });

  it("places the skills block before the date/cwd footer", () => {
    const prompt = buildSystemPrompt({ skills });
    const skillsIdx = prompt.indexOf("</available_skills>");
    const dateIdx   = prompt.indexOf("Current date:");
    expect(skillsIdx).toBeGreaterThan(0);
    expect(dateIdx).toBeGreaterThan(skillsIdx);
  });
});
