/**
 * System prompt for the Hackspace agent.
 *
 * Models its shape on pi's `buildSystemPrompt` (see earendil-works/pi
 * `packages/coding-agent/src/core/system-prompt.ts`). The section
 * order, the `<available_skills>` XML block, and the date/cwd footer
 * are lifted verbatim; that structure is battle-tested as a coding-
 * agent preamble.
 *
 * Sections, in order:
 *
 *   1. Identity         — terse, one paragraph.
 *   2. Available tools  — one bullet per tool, front-loaded for attention.
 *   3. Hedge            — "you may have access to other custom tools".
 *   4. Guidelines       — per-tool ergonomics (read/write/edit) +
 *                          hackspace-specific meta-rules.
 *   5. <project_context> — execution environment, workspace layout,
 *                          file serving, workspace-ignore, originator
 *                          mention. Mirrors pi's <project_context>
 *                          slot (which inlines AGENTS.md). The
 *                          hackspace doesn't have an AGENTS.md file,
 *                          so we synthesise the equivalent here.
 *   6. Skills           — pi-style preamble + <available_skills> XML.
 *   7. Footer           — current date + cwd.
 *
 * Section 5 was previously emitted as four separate top-level blocks
 * between identity and tools. Pi's prompts keep tools and guidelines
 * close to the top (the high-attention zone) and push project-shaped
 * context to a single block before the skills section. We follow
 * that. The wording in each project-context sub-section is also
 * trimmed of "very important" framing — pi's prompt has no such
 * markers, and they were biasing the agent's tone.
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
  /** Current thread's id, substituted into the file-serving URL examples. */
  threadId?: string;
  /**
   * Path segments excluded from the container→DO pull (matches
   * Workspace's `pullIgnore`). Surfaced to the model so it knows
   * which paths won't appear via read/ls/grep/find. Pass an empty
   * array (or omit) to skip the workspace-ignore section.
   */
  pullIgnore?: string[];
  /**
   * Override "now" — exposed for tests. Production callers leave this
   * unset and get the current date in YYYY-MM-DD form.
   */
  now?: Date;
  /**
   * Person who started this thread. When set, the project_context
   * block grows a "Thread originator" subsection telling the agent
   * to @-mention them at the end of each turn so the notification
   * webhook can ping them in Google Chat.
   */
  originator?: { userId: string; name: string };
  /**
   * Public origin (no trailing slash) used to build absolute URLs in
   * agent messages. When empty the agent is instructed to skip URL
   * suggestions — a bare path is worse than no link.
   */
  baseUrl?: string;
  /** Active room id, used to anchor message links back to a specific message. */
  roomId?: string;
}

// ── Section 1: identity ────────────────────────────────────────────

const IDENTITY = `\
You are an expert TypeScript developer focused on building Cloudflare Workers,
the Cloudflare Agents SDK, and the Cloudflare Sandbox SDK. You design, deploy,
and exercise Workers from inside a Durable-Object-backed chat session.`;

// ── Section 2: tools ───────────────────────────────────────────────

const TOOL_SNIPPETS: Array<readonly [string, string]> = [
  ["read",      "read a file from the workspace"],
  ["write",     "create or overwrite a file"],
  ["edit",      "surgical edit of an existing file"],
  ["ls",        "list files and directories at a path"],
  ["stat",      "metadata for a file or directory"],
  ["mkdir",     "create a directory (and parents)"],
  ["rm",        "remove a file or directory recursively"],
  ["find",      "locate files by name substring"],
  ["grep",      "search file contents for a pattern"],
  ["exec",      "run a shell command on the 'shell' (default) or 'container' backend"],
  ["webfetch",  "fetch and summarize a URL"],
  ["websearch", "search the web for documentation or examples"],
];

// ── Section 4: guidelines ──────────────────────────────────────────

// Tool-ergonomics guidelines, lifted near-verbatim from pi's
// `buildSystemPrompt` (earendil-works/pi
// `packages/coding-agent/src/core/tools/{read,write,edit}.ts` ->
// `promptGuidelines`). Pi attaches these to each tool definition and
// folds them into the prompt at render time; we don't have a
// per-tool plumbing path yet, so we inline them here in the same
// order pi emits them.
//
// These are the rules that make the agent's editing behaviour feel
// reliable: they keep the model from emitting overlapping edits,
// from rewriting whole files when a surgical edit would do, and from
// preferring `exec cat` over the dedicated `read` tool.
const GUIDELINES = [
  // File-tool ergonomics (pi's read/write/edit promptGuidelines).
  "Use read to examine files instead of exec'ing cat or sed",
  "Use write only for new files or complete rewrites",
  "Use edit for precise changes \u2014 each edits[].oldText must match exactly",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions",

  // Exploration + backend selection. The exec tool's own description
  // already spells out the two backends in detail; this bullet exists
  // so the model sees the steering hint in the same pass as the rest
  // of the file-tool rules.
  "Prefer grep / find / ls over exec for file exploration",
  "exec defaults to the 'shell' backend (just-bash, instant boot, built-in git). Pass backend: 'container' when the command needs a real Node binary (npm, node, tsc, wrangler, esbuild)",

  // Hackspace-specific meta-rules.
  "When the user asks what you can do, how to get started, or how to use this agent, read the capabilities-overview skill and answer from it",
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

const SKILLS_PREAMBLE = `\
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

// ── Section 5: <project_context> sub-blocks ────────────────────────
//
// Each helper renders one sub-section's body (no leading/trailing
// blank lines). buildProjectContext stitches them together inside a
// single `<project_context>...</project_context>` wrapper. The order
// is: execution model → workspace layout → workspace ignore → file
// serving → originator mention. That's roughly "what is this place,
// then how do I behave in it".

const EXECUTION_BLOCK = `\
Execution environment — two planes the agent operates across:

- Agent (this conversation): a Durable Object running on Cloudflare's
  edge. Owns the conversation history and the workspace VFS
  (SQLite-backed inside the DO). All tools dispatch from here.
- Sandbox container: a companion container assigned to this session.
  \`exec\` runs inside it. The file tools (\`read\`/\`write\`/\`edit\`/\`ls\`/
  \`stat\`/\`mkdir\`/\`rm\`/\`find\`/\`grep\`) operate on the DO's VFS
  directly; the container mounts that VFS over FUSE so \`exec\` sees
  the same files without an explicit sync step.

Latency tiers (useful when picking a tool):
- File tools touch the DO-local VFS — single-digit ms.
- \`exec\` round-trips through the container — tens of ms warm,
  hundreds when the container is cold.`;

const WORKSPACE_LAYOUT_BLOCK = `\
Workspace layout:
- All files live under /workspace. Use absolute paths.`;

function workspaceIgnoreBlock(pullIgnore: string[]): string {
  const list = pullIgnore.map((p) => `\`${p}\``).join(", ");
  return [
    "Workspace ignore rules:",
    `- Paths matching ${list} are ignored by the post-exec sync, so they don't appear via \`read\`, \`write\`, \`edit\`, \`ls\`, \`stat\`, \`find\`, or \`grep\`. They are matched as path segments — any path containing \`/<name>/\` or ending in \`/<name>\`.`,
    "- The files still exist on the container side, so `exec` (and anything it runs — node, tsc, eslint, etc.) sees them normally.",
    "- `exec` *can* be used to read or grep an ignored file (e.g. `exec(\"cat /workspace/node_modules/foo/package.json\")`), but each call spawns a sandbox process and round-trips through the container — plan on hundreds of ms minimum. Reach for it only when no other tool can answer the question.",
    "- Prefer published documentation, `websearch` / `webfetch`, or the source repo's metadata over crawling installed dependencies.",
  ].join("\n");
}

function fileServingBlock(threadId: string, baseUrl: string): string {
  const tid = threadId || "<threadId>";
  const origin = baseUrl || "<APP_BASE_URL unset>";
  const prefix = `${origin}/api/threads/${tid}/files`;
  return [
    "Serving workspace files:",
    `- Any file in the workspace can be linked at \`${prefix}/<absolute-path>\`. The path after \`/files/\` is the absolute VFS path; \`/workspace/foo.png\` becomes \`${prefix}/workspace/foo.png\`.`,
    `- Emit absolute URLs that start with \`${origin}\`. Relative paths like \`/api/threads/...\` break in Google Chat notifications, copy-pasted snippets, and anywhere the message is rendered outside the app.`,
    `- Embed images inline with Markdown: \`![alt text](${prefix}/workspace/diagram.png)\`.`,
    "- Offer downloadable artifacts with an anchor and the `download` attribute, e.g.",
    `  \`<a href="${prefix}/workspace/build.zip?download" download>Download build.zip</a>\`.`,
    "- Add `?download` to the URL to force a Content-Disposition: attachment header so the browser saves the file instead of rendering it.",
    "- Don't fabricate file paths — only link files you actually created or that the user provided.",
    ...(baseUrl
      ? []
      : ["- `APP_BASE_URL` is not configured for this deployment. Skip URL suggestions until it is set; bare paths are worse than no link."]),
  ].join("\n");
}

/**
 * Originator-mention sub-section.
 *
 * Earlier wording used "It is very important …" framing twice, which
 * was biasing the model toward apologetic / pedantic prose. Pi's
 * prompts contain zero such markers. Rewritten as a neutral procedural
 * rule: the tag is required for the notifier to detect the mention,
 * the exact spelling matters, the cadence is once per turn.
 */
function originatorBlock(
  o: { userId: string; name: string },
  baseUrl: string,
  threadId: string,
  roomId: string,
): string {
  const deepLink =
    baseUrl && roomId && threadId
      ? `${baseUrl}/rooms/${roomId}/threads/${threadId}#<message-id>`
      : "";
  const tag = `<mention type="user" id="${o.userId}">@${o.name}</mention>`;
  return [
    "Thread originator:",
    `- This thread was started by ${o.name}. Close each turn with an @-mention so the notifier can ping them in Google Chat.`,
    `- The mention tag must appear verbatim in the message body: \`${tag}\`. The text between the tags is the human-readable handle; \`@${o.name}\` is fine, as is any short label.`,
    "- Don't paraphrase the tag (e.g. a plain `@name`) and don't wrap it in backticks or code blocks — the renderer and notifier both look for the literal `<mention …>` element.",
    "- Mention them exactly once per turn, at the end. Skip the mention only when the turn produced no user-facing output (e.g. interrupted before responding).",
    ...(deepLink
      ? [
          `- Google Chat pings include a deep link back to your message of the form \`${deepLink}\`, where \`<message-id>\` is the id of your final assistant message. The notifier builds the link; you don't need to.`,
        ]
      : []),
  ].join("\n");
}

function buildProjectContext(opts: {
  threadId: string;
  baseUrl: string;
  roomId: string;
  pullIgnore: string[];
  originator?: { userId: string; name: string };
}): string {
  const sections: string[] = [EXECUTION_BLOCK, WORKSPACE_LAYOUT_BLOCK];
  if (opts.pullIgnore.length > 0) sections.push(workspaceIgnoreBlock(opts.pullIgnore));
  sections.push(fileServingBlock(opts.threadId, opts.baseUrl));
  if (opts.originator) {
    sections.push(originatorBlock(opts.originator, opts.baseUrl, opts.threadId, opts.roomId));
  }
  return ["<project_context>", "", sections.join("\n\n"), "", "</project_context>"].join("\n");
}

// ── Top-level builder ──────────────────────────────────────────────

export function buildSystemPrompt(opts: BuildSystemPromptOptions = {}): string {
  const cwd        = opts.cwd ?? "/workspace";
  const skills     = opts.skills ?? [];
  const now        = opts.now ?? new Date();
  const threadId   = opts.threadId ?? "";
  const pullIgnore = opts.pullIgnore ?? [];
  const baseUrl    = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const roomId     = opts.roomId ?? "";
  const originator = opts.originator;

  const tools      = TOOL_SNIPPETS.map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  const guidelines = GUIDELINES.map((g) => `- ${g}`).join("\n");
  const projectContext = buildProjectContext({
    threadId, baseUrl, roomId, pullIgnore, originator,
  });

  const parts: string[] = [
    IDENTITY,
    "",
    "Available tools:",
    tools,
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    guidelines,
    "",
    projectContext,
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
