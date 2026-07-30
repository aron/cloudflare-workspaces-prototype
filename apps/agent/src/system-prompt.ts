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
 *   5. <project_context> — optional inlined AGENTS.md document plus
 *                          execution environment, workspace layout,
 *                          file serving, workspace-ignore, and
 *                          originator mention. Mirrors pi's
 *                          <project_context> slot (which inlines
 *                          AGENTS.md from the project root). The
 *                          AGENTS.md content, when present, is
 *                          rendered as a <project_instructions
 *                          path="AGENTS.md">...</project_instructions>
 *                          sub-block before the operational notes,
 *                          so any project-specific persona / style /
 *                          house-rule guidance lands first.
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
  /**
   * Optional project-instructions document inlined into
   * `<project_context>`. Pi's `buildSystemPrompt` reads this from
   * an `AGENTS.md` file at the project root; the hackspace fetches
   * it from the SKILLS R2 bucket (key `AGENTS.md`) via
   * `fetchProjectInstructions` and caches the result on the Agent
   * DO. When unset or empty the block is skipped.
   */
  projectInstructions?: string;
  /**
   * Whether the `publish` tool is registered. It only exists when the
   * workspace was built with an assets client (R2 credentials set), so
   * the prompt must not advertise it otherwise.
   */
  publish?: boolean;
}

// ── Section 1: identity ────────────────────────────────────────────

const IDENTITY = `\
You are an expert TypeScript developer focused on building Cloudflare Workers,
the Cloudflare Agents SDK, and the Cloudflare Sandbox SDK. You design, deploy,
and exercise Workers from inside a Durable-Object-backed chat session.`;

// ── Section 2: tools ───────────────────────────────────────────────

// Mirrors the set `createAITools` registers plus this app's own
// additions. `publish` is conditional on the assets client, `delegate`
// on being the parent agent.
const TOOL_SNIPPETS: Array<readonly [string, string]> = [
  ["read",      "read a file from the workspace"],
  ["ls",        "list files and directories at a path"],
  ["write",     "create or overwrite a file"],
  ["edit",      "surgical edit of an existing file"],
  ["exec",      "run a shell command on the 'shell' (default) or 'container' backend"],
  ["publish",   "publish a workspace file and get a time-limited public URL"],
  ["webfetch",  "fetch a URL as Markdown (rendered in a real browser, so JS-heavy pages work)"],
  ["screenshot", "render a webpage in a headless browser and capture a screenshot (png/jpeg/webp, fullPage, selector, viewport)"],
  ["websearch", "search the web for documentation or examples"],
  ["delegate",  "start a named sub-agent that shares this workspace, or poll its result"],
  ["schedule",  "schedule a one-off or recurring task (create/list/cancel) that wakes you later; times are UTC"],
  ["cloudflare", "access the current user's Cloudflare account via MCP (connect/status/disconnect); unlocks search/execute over the whole Cloudflare API"],
];

/** Tool list for the parent agent, or for worker sub-agents (no delegate). */
function toolSnippetsFor(
  opts: { publish?: boolean; worker?: boolean } = {},
): Array<readonly [string, string]> {
  return TOOL_SNIPPETS.filter(([name]) => {
    if (name === "delegate") return opts.worker !== true;
    if (name === "publish") return opts.publish === true;
    return true;
  });
}

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
  // File-tool ergonomics shared by every model.
  "Use read to examine files instead of exec'ing cat or sed",
  "Use write only for new files or complete rewrites",

  // Exploration + backend selection. The exec tool's own description
  // already spells out the two backends in detail; this bullet exists
  // so the model sees the steering hint in the same pass as the rest
  // of the file-tool rules.
  "Prefer read / ls over exec for inspecting known paths; use exec on the default 'shell' backend for grep / find / sed sweeps — it is just-bash in an isolate, so those are cheap",
  "exec defaults to the 'shell' backend (just-bash, instant boot, built-in git). Pass backend: 'container' when the command needs a real Node/Bun binary (bun, npm, node, tsc, wrangler, esbuild). Prefer `bun install` over `npm install` in the sandbox because it is much faster",

  // Hackspace-specific meta-rules.
  "When the user asks what you can do, how to get started, or how to use this agent, read the capabilities-overview skill and answer from it",
  "Be concise in your responses",
  "Show file paths clearly when working with files",

  // Sub-agent delegation guidelines.
  "Use delegate to fan out a well-scoped, self-contained task — research, a long build, parallel file generation",
  "Give the sub-agent enough context in its task string to act without asking back — it has no conversation history beyond what you send",
  "Name sub-agents stably and descriptively: 'builder-1', 'researcher-auth'",
  "Sub-agents share the same workspace (/workspace). Coordinate paths explicitly — prefer separate subdirectories when working in parallel (e.g. /workspace/research/, /workspace/build/)",
  "Sub-agents cannot spawn further sub-agents — you are the planner",

  // Scheduling guidelines.
  "Use schedule to set a reminder or recurring job (e.g. 'check in 24h', 'every day at 8am summarize the backlog'). When a task fires you are woken with its prompt and run a normal turn",
  "schedule times are UTC — convert the user's wall-clock request to UTC. Use { type: 'delay', seconds } or { type: 'at', iso } for one-offs, { type: 'cron', cron } for recurring",
  "Use schedule command 'list' to show scheduled tasks and 'cancel' to remove one by id",

  // Cloudflare MCP guidelines.
  "Use the cloudflare tool to act on the current user's own Cloudflare account (DNS, Workers, R2, Zero Trust, etc.). Run cloudflare command 'connect' first; if it returns an authUrl, give the user that link to authorize, then retry",
  "Once connected, use the search/execute tools (from the Cloudflare MCP server) to explore and call any Cloudflare API endpoint",
  "Cloudflare auth is per-user: it uses the account of whoever sent the latest message. If a connection that worked before asks to authenticate again, the authorization expired — share the new link and ask the user to re-authorize",

  // Editing ergonomics for the package's `edit` tool.
  "Use edit for precise changes — each edits[].oldText must match exactly",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions",
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
  \`exec\` runs inside it when \`backend: 'container'\` is set. The file
  tools (\`read\`/\`ls\`/\`write\`/\`edit\`) operate on the DO's VFS
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
    `- Paths matching ${list} are ignored by the post-exec sync, so they don't appear via \`read\`, \`ls\`, \`write\`, or \`edit\`. They are matched as path segments — any path containing \`/<name>/\` or ending in \`/<name>\`.`,
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

/**
 * Render the AGENTS.md document as a `<project_instructions>`
 * sub-block. The shape matches pi's exactly:
 *
 *   <project_instructions path="AGENTS.md">
 *   ...body verbatim...
 *   </project_instructions>
 *
 * `path` is a fixed label; the hackspace fetches the body from R2
 * but the model doesn't need to know that — "AGENTS.md" is the
 * recognisable name and matches pi's convention.
 *
 * Body XML is *not* escaped: pi treats it as markdown and the
 * convention there is to write `<…>` snippets, code blocks, and
 * other markup directly. Escaping would make the document
 * unreadable. The wrapping tags are safe because the path
 * attribute is fixed and the content is bounded by the closing
 * `</project_instructions>` tag.
 */
function projectInstructionsBlock(body: string): string {
  return [
    'Project-specific instructions and guidelines:',
    "",
    '<project_instructions path="AGENTS.md">',
    body,
    "</project_instructions>",
  ].join("\n");
}

function buildProjectContext(opts: {
  threadId: string;
  baseUrl: string;
  roomId: string;
  pullIgnore: string[];
  originator?: { userId: string; name: string };
  projectInstructions?: string;
}): string {
  const sections: string[] = [];
  // AGENTS.md first — user-controlled persona / style / house rules
  // outrank runtime operational notes. Mirrors pi's emission order:
  // <project_instructions> comes immediately after the
  // <project_context> opener.
  if (opts.projectInstructions && opts.projectInstructions.trim().length > 0) {
    sections.push(projectInstructionsBlock(opts.projectInstructions.trim()));
  }
  sections.push(EXECUTION_BLOCK, WORKSPACE_LAYOUT_BLOCK);
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

  const tools      = toolSnippetsFor({ publish: opts.publish }).map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  const guidelines = GUIDELINES.map((g) => `- ${g}`).join("\n");
  const projectContext = buildProjectContext({
    threadId, baseUrl, roomId, pullIgnore, originator,
    projectInstructions: opts.projectInstructions,
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

// ── Worker (sub-agent) system prompt ──────────────────────────────

const WORKER_IDENTITY = `\
You are a worker agent operating inside a shared workspace at /workspace.
You have been given a specific task by the orchestrating agent. Complete it
precisely using the tools available, then stop. Do not ask for clarification —
make your best judgement on any ambiguities. End your final message with a
concise summary of what you did and what changed.`;

/**
 * Build a terse system prompt for a SubAgent worker.
 *
 * Omits skills, project context, and originator blocks — those are
 * parent-level concerns. Includes the same tool list (minus delegate),
 * the same file-tool ergonomics guidelines, and the standard footer.
 */
export function buildWorkerSystemPrompt(opts: { now?: Date; publish?: boolean } = {}): string {
  const now = opts.now ?? new Date();
  const tools = toolSnippetsFor({ publish: opts.publish, worker: true }).map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  // Worker guidelines: file-tool ergonomics + exec backend selection.
  // Drop hackspace meta-rules and sub-agent delegation rules — workers
  // don’t use them.
  const workerGuidelines = [...GUIDELINES]
    .filter(g => !g.startsWith("When the user asks") && !g.startsWith("Use delegate") && !g.startsWith("Sub-agents") && !g.startsWith("Name sub-agents") && !g.startsWith("Give the sub-agent"))
    .map(g => `- ${g}`);

  return [
    WORKER_IDENTITY,
    "",
    "Available tools:",
    tools,
    "",
    "Guidelines:",
    ...workerGuidelines,
    "",
    `Current date: ${formatDate(now)}`,
    "Current working directory: /workspace",
  ].join("\n");
}
