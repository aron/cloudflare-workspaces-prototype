/**
 * System prompt for the Hackspace agent.
 *
 * Models its shape on pi's `buildSystemPrompt` (see earendil-works/pi
 * `packages/coding-agent/src/core/system-prompt.ts`). The exact wording
 * is ours, but the section order, the `<available_skills>` XML block,
 * and the date/cwd footer are lifted verbatim — that structure is
 * battle-tested as a coding-agent preamble.
 *
 * The agent is intentionally one fixed persona: a TypeScript developer
 * focused on Cloudflare Workers, the Cloudflare Agents SDK, and the
 * Cloudflare Sandbox SDK. Specialization comes from skills mounted from
 * R2 at `/workspace/.agents/skills/<name>/SKILL.md`; their metadata is
 * enumerated here and the agent loads bodies via the `read` tool.
 */

/** Metadata for one skill, as it appears in `<available_skills>`. */
export interface Skill {
  /** Lowercase-kebab name, also the directory name under .agents/skills. */
  name: string;
  /** One-paragraph description from the skill's front-matter. */
  description: string;
  /** Absolute VFS path to the skill's SKILL.md entry point. */
  location: string;
}

export interface BuildSystemPromptOptions {
  /** Working directory shown in the footer. Defaults to `/workspace`. */
  cwd?: string;
  /** Discovered skills enumerated in the prompt's `<available_skills>` block. */
  skills?: Skill[];
  /**
   * Override "now" — exposed for tests. Production callers leave this
   * unset and get the current date in YYYY-MM-DD form.
   */
  now?: Date;
}

const IDENTITY = `\
You are an expert TypeScript developer focused on building Cloudflare Workers,
the Cloudflare Agents SDK, and the Cloudflare Sandbox SDK. You design, deploy,
and exercise Workers from inside a Durable-Object-backed chat session.`;

const WORKSPACE_NOTE = `\
Workspace:
- All files live under /workspace. Use absolute paths.
- The build container has network access; the deployed Worker does not
  (\`globalOutbound: null\`).`;

const TOOL_SNIPPETS: Array<readonly [string, string]> = [
  ["read",            "read a file from the workspace"],
  ["write",           "create or overwrite a file"],
  ["edit",            "surgical edit of an existing file"],
  ["ls",              "list files and directories at a path"],
  ["stat",            "metadata for a file or directory"],
  ["mkdir",           "create a directory (and parents)"],
  ["rm",              "remove a file or directory recursively"],
  ["find",            "locate files by name substring"],
  ["grep",            "search file contents for a pattern"],
  ["exec",            "run a build/compile command in the container"],
  ["webfetch",        "fetch and summarize a URL"],
  ["websearch",       "search the web for documentation or examples"],
  ["git_clone",       "clone a public GitHub repo into the workspace"],
  ["git_create_repo", "create an empty repo in the session's Artifacts bucket"],
  ["git_list_repos",  "list repos available to this session"],
  ["git_commit",      "commit the current working tree"],
  ["git_push",        "push HEAD to the per-session fork on Artifacts"],
  ["git_share",       "snapshot the working tree and return a short-lived URL the user can `git remote add` and clone locally"],
  ["worker_deploy",   "build a Worker from /workspace/wrangler.jsonc and load it"],
  ["worker_fetch",    "send a fetch() call to the loaded Worker"],
];

const GUIDELINES = [
  "Prefer grep / find / ls over exec for file exploration",
  "Use worker_deploy + worker_fetch to test Workers, not exec",
  "When the user asks what you can do, how to get started, or how to use this agent, read the capabilities-overview skill and answer from it",
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

const SKILLS_PREAMBLE = `\
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

export function buildSystemPrompt(opts: BuildSystemPromptOptions = {}): string {
  const cwd    = opts.cwd ?? "/workspace";
  const skills = opts.skills ?? [];
  const now    = opts.now ?? new Date();

  const tools = TOOL_SNIPPETS.map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  const guidelines = GUIDELINES.map(g => `- ${g}`).join("\n");

  const parts: string[] = [
    IDENTITY,
    "",
    WORKSPACE_NOTE,
    "",
    "Available tools:",
    tools,
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    guidelines,
  ];

  if (skills.length > 0) {
    parts.push("", SKILLS_PREAMBLE, "", "<available_skills>");
    for (const s of skills) {
      parts.push("  <skill>");
      parts.push(`    <name>${escapeXml(s.name)}</name>`);
      parts.push(`    <description>${escapeXml(s.description)}</description>`);
      parts.push(`    <location>${escapeXml(s.location)}</location>`);
      parts.push("  </skill>");
    }
    parts.push("</available_skills>");
  }

  parts.push("", `Current date: ${formatDate(now)}`);
  parts.push(`Current working directory: ${cwd}`);

  return parts.join("\n");
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
