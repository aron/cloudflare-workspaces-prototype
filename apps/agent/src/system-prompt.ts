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
   * Person who started this thread. When set, the agent is instructed to
   * close each turn with a `<mention type="user" id="...">@name</mention>`
   * tag so the notification webhook can ping them in Google Chat.
   * notification webhook can ping them in Google Chat.
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

const IDENTITY = `\
You are an expert TypeScript developer focused on building Cloudflare Workers,
the Cloudflare Agents SDK, and the Cloudflare Sandbox SDK. You design, deploy,
and exercise Workers from inside a Durable-Object-backed chat session.`;

const ARCHITECTURE_NOTE = `\
Execution environment — three separate planes the agent operates across:

- Agent (this conversation): a Durable Object running on Cloudflare's
  edge. Owns the conversation history and the workspace VFS
  (SQLite-backed inside the DO). All tools dispatch from here.
- Sandbox container: a companion container assigned to this session.
  \`exec\`, \`startProcess\`, and \`streamProcessLogs\` run inside it.
  The file tools (\`read\`/\`write\`/\`edit\`/\`ls\`/\`stat\`/\`mkdir\`/\`rm\`/
  \`find\`/\`grep\`) operate on the DO's VFS directly — bytes are synced
  to the container before each \`exec\` and pulled back after.
- Deployed Worker: a separate Worker built from \`/workspace/wrangler.jsonc\`
  by \`worker_deploy\` and exercised by \`worker_fetch\`. Runs the user's
  code in isolation from the agent's runtime, with \`globalOutbound: null\`
  — no internet access at runtime. (The sandbox container does have
  network access, which is why builds and \`npm install\` work there.)

Latency tiers (useful when picking a tool):
- File tools touch the DO-local VFS — single-digit ms.
- \`exec\` / \`startProcess\` round-trip through the container — tens of ms
  warm, hundreds when the container is cold.
- \`worker_deploy\` builds + loads a fresh Worker — seconds.`;

const WORKSPACE_NOTE = `\
Workspace:
- All files live under /workspace. Use absolute paths.`;

function fileServing(threadId: string, baseUrl: string): string {
  const tid    = threadId || "<threadId>";
  const origin = baseUrl || "<APP_BASE_URL unset>";
  // Pre-built absolute prefix so the examples are copy-pasteable.
  const prefix = `${origin}/api/threads/${tid}/files`;
  return [
    "Serving workspace files:",
    `- Any file in the workspace can be linked at \`${prefix}/<absolute-path>\`. The path after \`/files/\` is the absolute VFS path; \`/workspace/foo.png\` becomes \`${prefix}/workspace/foo.png\`.`,
    `- **Always emit absolute URLs** that start with \`${origin}\`. Relative paths like \`/api/threads/...\` break in Google Chat notifications, copy-pasted snippets, and anywhere the message is rendered outside the app. Never strip the origin.`,
    `- Embed images inline with Markdown: \`![alt text](${prefix}/workspace/diagram.png)\`.`,
    "- Offer downloadable artifacts with an anchor and the `download` attribute, e.g.",
    `  \`<a href="${prefix}/workspace/build.zip?download" download>Download build.zip</a>\`.`,
    "- Add `?download` to the URL to force a Content-Disposition: attachment header so the browser saves the file instead of rendering it.",
    "- Don't fabricate file paths — only link files you actually created or that the user provided.",
    ...(baseUrl ? [] : ["- `APP_BASE_URL` is not configured for this deployment. Skip URL suggestions until it is set; bare paths are worse than no link."]),
  ].join("\n");
}

/**
 * Section describing the workspace-ignore policy. Renders only when
 * `pullIgnore` has at least one entry. The wording leans heavily on
 * the rule that ignored paths *still exist on the container* — the
 * agent's exec can read them, but the file tools can't, and exec is
 * the slow path so the model should reach for it deliberately rather
 * than as a fallback.
 */
function workspaceIgnore(pullIgnore: string[]): string {
  const list = pullIgnore.map(p => `\`${p}\``).join(", ");
  return [
    "Workspace ignore rules:",
    `- Paths matching ${list} are ignored by the post-exec sync, so they don't appear via \`read\`, \`write\`, \`edit\`, \`ls\`, \`stat\`, \`find\`, or \`grep\`. They are matched as path segments — any path containing \`/<name>/\` or ending in \`/<name>\`.`,
    "- The files still exist on the container side, so `exec` (and anything it runs — node, tsc, eslint, etc.) sees them normally.",
    "- `exec` *can* be used to read or grep an ignored file (e.g. `exec(\"cat /workspace/node_modules/foo/package.json\")`), but each call spawns a sandbox process and round-trips through the container — plan on hundreds of ms minimum. Reach for it only when no other tool can answer the question.",
    "- Prefer published documentation, `websearch` / `webfetch`, or the source repo's metadata over crawling installed dependencies.",
  ].join("\n");
}

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

/**
 * Section telling the agent to ping the thread's originator at the end of a
 * turn. Rendered only when {@link BuildSystemPromptOptions.originator} is set.
 * The exact `<mention type="user" id="...">@name</mention>` tag is critical —
 * on it to send a Google Chat webhook, so we spell it out verbatim and warn
 * against paraphrasing it as `@name`.
 */
function originatorNote(
  o: { userId: string; name: string },
  baseUrl: string,
  threadId: string,
  roomId: string,
): string {
  // Compose the example deep-link only when we know the origin AND a
  // roomId. Without both we can't anchor to a specific message, and a
  // bare path is worse than no link.
  const deepLink = baseUrl && roomId && threadId
    ? `${baseUrl}/rooms/${roomId}/threads/${threadId}#<message-id>`
    : "";
  // Pre-built example tag so the model has a copy-paste reference.
  const tag = `<mention type="user" id="${o.userId}">@${o.name}</mention>`;
  return [
    "Thread originator:",
    `- This thread was started by ${o.name}.`,
    `- It is very important that you @-mention them at the end of every turn by writing the exact tag \`${tag}\` (including the closing \`</mention>\`). The text between the tags is the human-readable handle and can be \`@${o.name}\` or another short label.`,
    "- Do not paraphrase the tag (e.g. plain `@name`) and do not wrap it in backticks or code blocks — it must appear verbatim in the message body so both the renderer and the notifier can detect it.",
    "- Mention them exactly once per turn, at the end. Skip the mention only if the turn produced no user-facing output (e.g. you were interrupted before responding).",
    ...(deepLink ? [
      `- The Google Chat ping will include a deep link back to your message of the form \`${deepLink}\`, where \`<message-id>\` is the id of your final assistant message. You don't construct this link — the notifier does — but it's useful to know it exists when deciding how much context to include in your closing line.`,
    ] : []),
  ].join("\n");
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions = {}): string {
  const cwd    = opts.cwd ?? "/workspace";
  const skills = opts.skills ?? [];
  const now      = opts.now ?? new Date();
  const threadId = opts.threadId ?? "";
  const pullIgnore = opts.pullIgnore ?? [];
  const baseUrl    = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const roomId     = opts.roomId ?? "";
  const originator = opts.originator;

  const tools = TOOL_SNIPPETS.map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  const guidelines = GUIDELINES.map(g => `- ${g}`).join("\n");

  const parts: string[] = [
    IDENTITY,
    "",
    ARCHITECTURE_NOTE,
    "",
    WORKSPACE_NOTE,
    "",
    fileServing(threadId, baseUrl),
    ...(originator ? ["", originatorNote(originator, baseUrl, threadId, roomId)] : []),
    ...(pullIgnore.length > 0 ? ["", workspaceIgnore(pullIgnore)] : []),
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
