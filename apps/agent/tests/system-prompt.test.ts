/**
 * Pure-function tests for src/system-prompt.ts. No DOs, no bindings.
 *
 * The system prompt is modelled on pi's `buildSystemPrompt` shape so the
 * structure stays familiar:
 *   identity → tools → custom-tools hedge → guidelines →
 *   <project_context>...</project_context> →
 *   skills preamble + <available_skills> XML → date/cwd footer
 *
 * Project context inlines architecture, workspace layout, optional
 * workspace-ignore rules, file-serving conventions, and (when set)
 * the thread originator's @-mention rule. That keeps tools and
 * guidelines in the high-attention top of the prompt and groups
 * project-shaped operational notes into one block before skills.
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

  it("emits sections in pi's order: identity → tools → guidelines → project_context → footer", () => {
    // The whole point of the reshuffle is keeping tools + guidelines
    // in the early high-attention region. Pin the ordering so a
    // future refactor can't move project_context back above tools.
    const prompt = buildSystemPrompt({});
    const identityIdx = prompt.indexOf("expert TypeScript developer");
    const toolsIdx    = prompt.indexOf("Available tools:");
    const guideIdx    = prompt.indexOf("Guidelines:");
    const ctxIdx      = prompt.indexOf("<project_context>");
    const dateIdx     = prompt.indexOf("Current date:");
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(identityIdx);
    expect(guideIdx).toBeGreaterThan(toolsIdx);
    expect(ctxIdx).toBeGreaterThan(guideIdx);
    expect(dateIdx).toBeGreaterThan(ctxIdx);
  });
});

describe("buildSystemPrompt — tool list", () => {
  it("lists every default tool the agent registers, each on its own bullet", () => {
    const prompt = buildSystemPrompt({});
    const expected = [
      "read", "ls", "write", "edit",
      "exec",
      "webfetch", "websearch",
    ];
    for (const name of expected) {
      expect(prompt).toMatch(new RegExp(`\\n- ${name}: `));
    }
    // Retired in the createAITools adoption.
    for (const gone of ["apply_patch", "stat", "mkdir", "rm", "find", "grep"]) {
      expect(prompt).not.toMatch(new RegExp(`\\n- ${gone}: `));
    }
  });

  it("only advertises publish when the assets client is configured", () => {
    expect(buildSystemPrompt({})).not.toMatch(/\n- publish: /);
    expect(buildSystemPrompt({ publish: true })).toMatch(/\n- publish: /);
  });

  it("includes the custom-tools hedge sentence after the tool list", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/In addition to the tools above, you may have access to other custom tools/);
  });
});

describe("buildSystemPrompt — guidelines", () => {
  it("includes the file-exploration preference, Bun install preference, and always-on bullets", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/Prefer read \/ ls over exec for inspecting known paths/);
    expect(prompt).toMatch(/Prefer `bun install` over `npm install`/);
    expect(prompt).toMatch(/- Be concise/);
    expect(prompt).toMatch(/- Show file paths clearly/);
  });

  // Per-tool ergonomics guidelines lifted from pi's buildSystemPrompt.
  // These are what stop the model from rewriting whole files, emitting
  // overlapping edits, or falling back to `exec cat` for reads. Asserted
  // explicitly because their absence is the exact behaviour drift we're
  // trying to fix — if a future refactor drops one of these, the test
  // should fail loudly.
  it("includes pi's per-tool ergonomics rules for read/write/edit", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/Use read to examine files instead of exec'ing cat or sed/);
    expect(prompt).toMatch(/Use write only for new files or complete rewrites/);
    expect(prompt).toMatch(/Use edit for precise changes/);
    expect(prompt).toMatch(/edits\[\]\.oldText must match exactly/);
    expect(prompt).toMatch(/use one edit call with multiple entries in edits\[\]/);
    expect(prompt).toMatch(/matched against the original file, not after earlier edits are applied/);
    expect(prompt).toMatch(/Do not emit overlapping or nested edits/);
    expect(prompt).toMatch(/Keep edits\[\]\.oldText as small as possible/);
  });

  it("tells the model to load the capabilities-overview skill when asked what it can do", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/capabilities-overview/);
    expect(prompt).toMatch(/what can you do|what you can do|how to use/i);
  });
});

describe("buildSystemPrompt — project_context: project instructions", () => {
  // Pi inlines AGENTS.md into <project_context> as a
  // <project_instructions> sub-block. The hackspace mirrors that
  // shape but sources the body from R2 instead of disk. These
  // tests pin the rendering: presence/absence, ordering relative to
  // operational notes, and XML safety.

  it("omits the project_instructions block when projectInstructions is unset", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toMatch(/<project_instructions/);
    expect(prompt).not.toMatch(/Project-specific instructions/);
  });

  it("omits the block when projectInstructions is empty or whitespace", () => {
    expect(buildSystemPrompt({ projectInstructions: "" })).not.toMatch(/<project_instructions/);
    expect(buildSystemPrompt({ projectInstructions: "   \n  " })).not.toMatch(/<project_instructions/);
  });

  it("renders the project_instructions block with the AGENTS.md path label", () => {
    const body = "# House rules\n- Always use absolute paths.\n- Prefer tsc strict mode.";
    const prompt = buildSystemPrompt({ projectInstructions: body });
    expect(prompt).toMatch(/Project-specific instructions and guidelines:/);
    expect(prompt).toMatch(/<project_instructions path="AGENTS\.md">/);
    expect(prompt).toMatch(/<\/project_instructions>/);
    // Body lands verbatim, not XML-escaped (it's markdown).
    expect(prompt).toContain("# House rules");
    expect(prompt).toContain("- Always use absolute paths.");
  });

  it("places project_instructions before the operational notes inside <project_context>", () => {
    // AGENTS.md (user-controlled) should outrank runtime operational
    // notes; the model reads it first inside the context block.
    const prompt = buildSystemPrompt({
      projectInstructions: "# House rules\nSomething.",
    });
    const ctxStart = prompt.indexOf("<project_context>");
    const instrIdx = prompt.indexOf("<project_instructions");
    const execIdx  = prompt.indexOf("Execution environment");
    expect(ctxStart).toBeGreaterThan(0);
    expect(instrIdx).toBeGreaterThan(ctxStart);
    expect(execIdx).toBeGreaterThan(instrIdx);
  });

  it("keeps markdown special characters in the body untouched", () => {
    // The body is markdown by convention — inline `<Foo>` snippets,
    // code blocks, etc. Escaping would make the document unreadable.
    // Pin that we don't accidentally start escaping in a future refactor.
    const body = '```ts\nconst x: <Foo & "bar"> = 1;\n```';
    const prompt = buildSystemPrompt({ projectInstructions: body });
    expect(prompt).toContain('const x: <Foo & "bar"> = 1;');
  });
});

describe("buildSystemPrompt — project_context: execution environment", () => {
  // The execution-environment sub-block is the model's grounding when
  // a user asks where their code runs, why exec is slow, or whether
  // the deployed Worker has internet. The wording matters for those
  // answers — pin the structural claims here so a future copy-edit
  // can't accidentally collapse the two planes back together.

  it("names the two planes the agent operates across", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/- Agent \(this conversation\):/);
    expect(prompt).toMatch(/- Sandbox container:/);
  });

  it("identifies the agent as a Durable Object owning the VFS", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/Durable Object/);
    expect(prompt).toMatch(/VFS/);
    expect(prompt).toMatch(/SQLite/);
  });

  it("places exec in the sandbox container, not the DO", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/`exec` runs inside it/);
  });

  it("explains that file tools sync to the container around exec", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/FUSE/);
    expect(prompt).toMatch(/same files/);
  });

  it("lists latency tiers so the model can pick tools accordingly", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/Latency tiers/);
    expect(prompt).toMatch(/File tools[\s\S]*single-digit ms/);
    expect(prompt).toMatch(/`exec`[\s\S]*tens of ms/);
  });

  it("lives inside the <project_context> block", () => {
    // The execution section moved out of a top-level slot into the
    // project_context wrapper; pin that so it stays grouped with
    // the other operational sub-sections.
    const prompt = buildSystemPrompt({});
    const ctxStart = prompt.indexOf("<project_context>");
    const ctxEnd   = prompt.indexOf("</project_context>");
    const execIdx  = prompt.indexOf("Execution environment");
    expect(ctxStart).toBeGreaterThan(0);
    expect(ctxEnd).toBeGreaterThan(ctxStart);
    expect(execIdx).toBeGreaterThan(ctxStart);
    expect(execIdx).toBeLessThan(ctxEnd);
  });
});

describe("buildSystemPrompt — project_context: workspace layout", () => {
  it("includes the workspace-paths reminder", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/All files live under \/workspace/);
  });
});

describe("buildSystemPrompt — project_context: file serving", () => {
  it("tells the model the URL shape for serving workspace files", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/\/api\/threads\/<threadId>\/files\//);
  });

  it("mentions inline embedding (images) and the download attribute pattern", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/!\[/);
    expect(prompt).toMatch(/download/);
  });

  it("substitutes the threadId into URL examples when provided", () => {
    const prompt = buildSystemPrompt({ threadId: "abc123" });
    expect(prompt).toMatch(/\/api\/threads\/abc123\/files\/workspace\/diagram\.png/);
    expect(prompt).not.toMatch(/<threadId>/);
  });

  it("falls back to <threadId> placeholder when no id is provided", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toMatch(/\/api\/threads\/<threadId>\/files\//);
  });
});

describe("buildSystemPrompt — project_context: workspace ignore", () => {
  it("omits the workspace-ignore section when pullIgnore is missing", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toMatch(/Workspace ignore rules/);
  });

  it("omits the workspace-ignore section when pullIgnore is empty", () => {
    // [] is the documented way to disable Workspace's pull-ignore;
    // the prompt section should disappear in lockstep so the model
    // isn't told about ignores that don't apply.
    const prompt = buildSystemPrompt({ pullIgnore: [] });
    expect(prompt).not.toMatch(/Workspace ignore rules/);
  });

  it("lists each pullIgnore entry verbatim in backticks", () => {
    const prompt = buildSystemPrompt({ pullIgnore: ["node_modules", ".cache"] });
    expect(prompt).toMatch(/`node_modules`/);
    expect(prompt).toMatch(/`\.cache`/);
  });

  it("explains that ignored paths don't appear via the file tools", () => {
    const prompt = buildSystemPrompt({ pullIgnore: ["node_modules"] });
    expect(prompt).toMatch(/don't appear via/);
    for (const name of ["read", "ls", "write", "edit"]) {
      expect(prompt).toMatch(new RegExp(`\\\`${name}\\\``));
    }
  });

  it("tells the model that exec sees ignored files but is the slow path", () => {
    const prompt = buildSystemPrompt({ pullIgnore: ["node_modules"] });
    expect(prompt).toMatch(/files still exist on the container side/);
    expect(prompt).toMatch(/\bexec\b/);
    expect(prompt).toMatch(/performance|slow|hundreds of ms|round-trip/i);
  });
});

describe("buildSystemPrompt — project_context: originator", () => {
  // The mention tag is required for the Google Chat notifier to fire
  // when a turn references the thread starter. Pin both the presence
  // of the rule and (negatively) the absence of the old "very
  // important" framing pi-style prompts avoid.

  const o = { userId: "u-venkman", name: "Venkman" };

  it("omits the originator block entirely when no originator is set", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toMatch(/Thread originator/);
  });

  it("includes the originator block and the literal mention tag when set", () => {
    const prompt = buildSystemPrompt({ originator: o });
    expect(prompt).toMatch(/Thread originator:/);
    expect(prompt).toMatch(/<mention type="user" id="u-venkman">@Venkman<\/mention>/);
  });

  it("instructs the agent to close each turn with the mention, once", () => {
    const prompt = buildSystemPrompt({ originator: o });
    expect(prompt).toMatch(/Close each turn with an @-mention/);
    expect(prompt).toMatch(/exactly once per turn/);
  });

  it("uses neutral phrasing instead of the older 'very important' framing", () => {
    // The earlier wording said "It is very important that you …",
    // which biased the model's tone. pi's prompts have no such
    // markers; this assertion is a regression guard against
    // reintroducing them.
    const prompt = buildSystemPrompt({ originator: o });
    expect(prompt).not.toMatch(/very important/i);
  });

  it("includes the deep-link example only when baseUrl + roomId + threadId are all known", () => {
    // Without baseUrl/roomId the link can't be anchored to a
    // specific message, so the prompt should skip the example.
    const noLink = buildSystemPrompt({ originator: o });
    expect(noLink).not.toMatch(/#<message-id>/);

    const withLink = buildSystemPrompt({
      originator: o,
      baseUrl: "https://example.workers.dev",
      roomId: "r1",
      threadId: "t1",
    });
    expect(withLink).toMatch(/https:\/\/example\.workers\.dev\/rooms\/r1\/threads\/t1#<message-id>/);
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

  it("places the skills block after project_context and before the date/cwd footer", () => {
    const prompt = buildSystemPrompt({ skills });
    const ctxEnd    = prompt.indexOf("</project_context>");
    const skillsIdx = prompt.indexOf("</available_skills>");
    const dateIdx   = prompt.indexOf("Current date:");
    expect(ctxEnd).toBeGreaterThan(0);
    expect(skillsIdx).toBeGreaterThan(ctxEnd);
    expect(dateIdx).toBeGreaterThan(skillsIdx);
  });
});
