/**
 * Agent — a Think-based DO that owns one Slack-style conversation.
 *
 * Inherits from `@cloudflare/think` for the agentic loop, Session-backed
 * message storage (branches, FTS5, non-destructive compaction), durable
 * chat fibers via `chatRecovery`, stream resumption, and the lifecycle
 * hooks. The custom `@cloudflare/workspace` Workspace stays put — it
 * owns the SQLite VFS, the container sync, and the capnweb session.
 *
 * This file only does chat-shaped things: defining tools, picking a model,
 * and persisting per-turn config. The model call itself is owned by Think.
 *
 *
 * Sub-agents: a top-level Agent can spawn `SubAgent` facets via
 * `this.subAgent(SubAgent, name)` for fan-out work (research, parallel
 * compilation, longer-horizon side tasks). The class lives at the bottom
 * of this file with the same Think baseline (chatRecovery on, empty tool
 * set by default — fill in per use case).
 */
import { Think } from "@cloudflare/think";
import { generateText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { Workspace, R2Bucket as R2Mount } from "@cloudflare/workspace";

import {
  createEditTool,
  createReadTool,
  createWriteTool,
  WorkspaceFileStore,
} from "@cloudflare/fs-tools";
import { createGitCloneTool } from "@cloudflare/git-tools";
import {
  createBraveSearchProvider,
  createWebFetchTool,
  createWebSearchTool,
} from "@cloudflare/web-tools";
import { resolveContainerId } from "./pool.js";
import { currentModelId } from "./model.js";
import { readIdentity } from "./identity.js";
import { extractAuthorFromUpgradeRequest, stampChatFrame, type ChatAuthor } from "./author-stamp.js";
import { WorkerDeployer } from "./worker/deploy.js";
import type { DeployResult } from "./worker/deploy.js";
import { parseFetchCall, fetchAgainstWorker } from "./worker/fetch.js";
import type { FetchToolResult, ParsedFetch } from "./worker/fetch.js";
import { buildSystemPrompt, type Skill } from "./system-prompt.js";
import { discoverSkills } from "./skills.js";

export { WorkerDeployer, parseFetchCall, fetchAgainstWorker };
export type { DeployResult, FetchToolResult, ParsedFetch };

const WORKSPACE   = "/workspace";
const SKILLS_PATH = "/workspace/.agents/skills";


export class Agent extends Think<Env> {
  /** Wrap each chat turn in a runFiber so streams survive DO eviction. */
  override chatRecovery = true;

  /** Max tool-call rounds per turn (preserves stepCountIs(20) from old impl). */
  override maxSteps = 20;

  /**
   * Our custom container-backed Workspace. Think types its own
   * `workspace` property as `WorkspaceLike` from `@cloudflare/shell`,
   * but ours owns a FUSE/capnweb sync to a sandbox container plus
   * `exec`/`runWasm` — functionality the shell interface doesn't model.
   * We override the type to `any` so the field carries our concrete
   * shape; nothing in this class routes through Think's builtin file
   * tools (we don't call `createWorkspaceTools` and we don't wire any
   * shell-shaped consumers), so the type relaxation is safe.
   */
  declare workspace: any;

  /** Lazily-constructed deployer for worker_deploy. */
  private _deployer?: WorkerDeployer;

  /** Cached skill metadata enumerated in the system prompt. */
  private _skills: Skill[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage:   this.ctx.storage,
      sandbox:   this.env.Sandbox,
      sessionId: this.name,
      resolveSessionId: (id) => resolveContainerId(this.env, id),
      // R2-backed mount of the shared skills bucket. The agent reads
      // SKILL.md bodies through this mount via the normal `read` tool;
      // discovery below indexes the metadata for the system prompt.
      mounts: this.env.SKILLS
        ? { [SKILLS_PATH]: R2Mount(this.env.SKILLS) }
        : {},
    });
    this.ctx.blockConcurrencyWhile(async () => {
      await this.workspace.mkdir(WORKSPACE);
      // Index the skills mount once at construction so getSystemPrompt()
      // stays synchronous and never serves an empty <available_skills>
      // block after a cold start.
      try {
        this._skills = await discoverSkills(this.workspace);
      } catch {
        this._skills = [];
      }
    });
  }

  private get deployer(): WorkerDeployer {
    if (!this._deployer) {
      this._deployer = new WorkerDeployer(this.workspace, this.env.LOADER);
    }
    return this._deployer;
  }

  onStart() {
    // Pre-warm: kick off container boot in background, don't block.
    this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));
  }

  // ── Think hooks ───────────────────────────────────────

  /**
   * Single fixed system prompt for the TypeScript / Cloudflare /
   * Agents / Sandbox agent. Specialization comes from skills, which
   * are enumerated in the prompt's <available_skills> block and
   * loaded on demand via the read tool.
   */
  override getSystemPrompt(): string {
    return buildSystemPrompt({ cwd: WORKSPACE, skills: this._skills });
  }

  /**
   * Model selection: OpenAI when `OPENAI_API_KEY` is set, otherwise
   * the Workers AI fallback. Mirrors the old `onChatMessage` picker.
   */
  override getModel() {
    const modelId = currentModelId(this.env);
    if (this.env.OPENAI_API_KEY) {
      return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(modelId);
    }
    return createWorkersAI({ binding: this.env.AI })(modelId);
  }

  /**
   * Per-turn config. Two jobs:
   *  1. Pre-warm the container so `exec` calls hit a hot sandbox.
   *     The old impl did this in an `onMessage` override watching for
   *     `cf_agent_use_chat_request`; Think gives us a cleaner spot.
   *  2. Pin OpenAI reasoning options for Zero-Data-Retention orgs:
   *     `store: false` + `include: reasoning.encrypted_content` so
   *     reasoning is round-tripped inline rather than referenced by id.
   */
  override beforeTurn() {
    this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));
    return {
      providerOptions: {
        openai: {
          reasoningEffort:
            (this.env as any).OPENAI_REASONING_EFFORT ?? "medium",
          reasoningSummary: "auto",
          store: false,
          include: ["reasoning.encrypted_content"]
        }
      }
    };
  }

  /**
   * Introspection RPC — returns the bits of TurnConfig that don't
   * require a real model call. Used by tests to assert the persona
   * prompt, ZDR posture, and that a model object is constructable.
   */
  previewTurnConfig(): {
    systemPrompt: string;
    providerOptions: ReturnType<Agent["beforeTurn"]>["providerOptions"];
    modelDefined: boolean;
  } {
    return {
      systemPrompt: this.getSystemPrompt(),
      providerOptions: this.beforeTurn().providerOptions,
      modelDefined: (() => {
        // getModel() may throw if the AI binding is absent (tests).
        try { return this.getModel() !== undefined; } catch { return false; }
      })()
    };
  }

  // ── Identity stamping (multi-human threads) ───────────────
  //
  // A single WS connection can be shared by multiple humans (the room view
  // posts on behalf of whoever is signed in). Capture the upgrade-time
  // identity on the connection and stamp incoming user messages with the
  // right `author` metadata before Think persists them.

  /**
   * Capture the human's identity from the WS upgrade request and stash it
   * on the connection. `connection.setState()` is persisted by the agents
   * SDK and survives hibernation, so we don't re-resolve on every wake.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onConnect(connection: any, ctx: any) {
    const author = extractAuthorFromUpgradeRequest(ctx.request as Request, readIdentity);
    if (author) connection.setState({ author });
    return super.onConnect?.(connection, ctx);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onMessage(connection: any, message: any) {
    if (typeof message === "string") {
      const author = (connection.state as { author?: ChatAuthor } | null)?.author ?? null;
      message = stampChatFrame(message, author);
      // A user reply arrived — arm the background summary tick. Idempotent,
      // so multiple frames in quick succession collapse onto one schedule.
      this.ctx.waitUntil(this.kickSummary());
    }
    return super.onMessage(connection, message);
  }

  /**
   * Fires after a chat turn completes and the assistant message has been
   * persisted. We use it to refresh the thread summary so the room view's
   * preview reflects what the agent just said.
   */
  override onChatResponse(): void {
    this.ctx.waitUntil(this.kickSummary());
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      return Response.json({
        count:    this.messages.length,
        messages: this.messages,
      }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname.endsWith("/vfs")) {
      const entries: Array<{ path: string; type: string; size: number; mtime: number }> = [];
      for (const e of this.workspace.vfs.snapshot().entries) {
        const stat = await this.workspace.stat(e.path);
        entries.push({ path: e.path, type: e.type, size: stat?.size ?? 0, mtime: e.mtime });
      }
      return Response.json({ count: entries.length, entries }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname.endsWith("/summary")) {
      return this.handleSummary();
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset")) {
      await this.clearMessages();
      return Response.json({ cleared: true });
    }

    // POST /seed { roomId, threadId, message } — called by Room when an
    // @agent mention mints a thread. Persists the originating user message
    // so the agent sees it on first turn. Idempotent: re-seeding the same
    // message id is a no-op so the client can safely retry.
    if (request.method === "POST" && url.pathname.endsWith("/seed")) {
      const body = await request.json().catch(() => ({})) as {
        roomId?: unknown; threadId?: unknown; message?: unknown;
      };
      const message = body.message;
      if (!message || typeof message !== "object") {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      const messageId = (message as { id?: unknown }).id;
      const alreadySeeded = typeof messageId === "string"
        && this.messages.some(m => m.id === messageId);
      if (!alreadySeeded) {
        // Cast through `any` — saveMessages accepts the AI SDK UIMessage shape;
        // we trust the caller (Room) to send a well-formed AppMessage.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.saveMessages([message as any]);
        // Seeding counts as a new message — arm the summary tick. The
        // assistant's reply will arm another one when its turn completes.
        this.ctx.waitUntil(this.kickSummary());
      }
      return Response.json({ ok: true, seeded: !alreadySeeded });
    }

    return new Response("not found", { status: 404 });
  }

  // ---- tools ----

  /**
   * Tools the agentic loop sees this turn. Single fixed tool set —
   * the agent has one persona, so there's no gating. webSearch is
   * registered only when BRAVE_API_KEY is configured.
   */
  override getTools() {
    return this.buildTools();
  }

  /** Introspection RPC: the set of tool names visible to the LLM. */
  activeToolNames(): string[] {
    return Object.keys(this.getTools());
  }

  private buildTools() {
    const ws = this.workspace;
    const pick = <T extends Record<string, unknown>>(name: string, def: T) =>
      ({ [name]: def });

    return {
      ...pick("read",  createReadTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("write", createWriteTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("edit",  createEditTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("webFetch", createWebFetchTool({ ai: this.env.AI })),
      ...(this.env.BRAVE_API_KEY
        ? pick("webSearch", createWebSearchTool({
            provider: createBraveSearchProvider({ apiKey: this.env.BRAVE_API_KEY }),
          }))
        : {}),

      ...pick("listDirectory", tool({
        description: "List files and directories at a path",
        inputSchema: z.object({ path: z.string().describe("Absolute directory path, e.g. /workspace") }),
        execute: async ({ path }) => ({ path, entries: await ws.readdir(path) }),
      })),

      ...pick("stat", tool({
        description: "Get metadata for a file or directory: type, size, mtime",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const s = await ws.stat(path);
          if (!s) return { error: `Not found: ${path}` };
          return { path, ...s };
        },
      })),

      ...pick("mkdir", tool({
        description: "Create a directory (including parent directories)",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => { await ws.mkdir(path); return { path, created: true }; },
      })),

      ...pick("deleteFile", tool({
        description: "Delete a file or directory (recursive)",
        inputSchema: z.object({ path: z.string().describe("Absolute path to delete") }),
        execute: async ({ path }) => { await ws.deleteFile(path); return { path, deleted: true }; },
      })),

      ...pick("findFiles", tool({
        description: "Search for files matching a pattern under a directory",
        inputSchema: z.object({
          directory: z.string().describe("Directory to search under, e.g. /workspace"),
          pattern:   z.string().optional().describe("Substring to match against filename, e.g. '.zig' or '.go'"),
        }),
        execute: async ({ directory, pattern }) => ({
          directory, pattern,
          matches: await ws.findFiles(directory, pattern),
        }),
      })),

      ...pick("grep", tool({
        description: "Search file contents for a string pattern. Returns matching lines.",
        inputSchema: z.object({
          pattern:    z.string().describe("String to search for"),
          path:       z.string().describe("File or directory to search"),
          ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
        }),
        execute: async ({ pattern, path, ignoreCase }) => ({
          pattern, path,
          matches: await ws.grep(pattern, path, { ignoreCase }),
        }),
      })),

      ...pick("exec", tool({
        description:
          "Run a shell command in the workspace sandbox. " +
          "Prefer the dedicated tools first: read/write/edit/listDirectory/stat/" +
          "mkdir/deleteFile/findFiles/grep for file ops, worker_deploy/worker_fetch " +
          "for Cloudflare Workers, run for compiled WASM binaries. " +
          "Primary use: compilation and build-tool invocation (zig, go, npm, etc.). " +
          "Fallback use: after the same dedicated tool has failed at least twice " +
          "in a row on the same input with errors that look like tool-level bugs " +
          "(not user input errors), it is acceptable to drop down to `exec` to " +
          "achieve the same effect \u2014 e.g. `cat`/`sed`/`mv` when `read`/`edit` " +
          "keeps erroring, `ls` when `listDirectory` fails. When you do this, " +
          "say so briefly in your response so the human can see the workaround " +
          "and report the underlying bug. Do not use `exec` as a first attempt " +
          "for anything a dedicated tool covers.",
        inputSchema: z.object({
          command: z.string().describe(
            "Build command, e.g. 'zig build-exe /workspace/main.zig -target wasm32-wasi -O ReleaseSmall -femit-bin=/workspace/main.wasm'",
          ),
          cwd: z.string().optional().describe("Working directory, defaults to /tmp"),
        }),
        execute: async ({ command, cwd }) => {
          try {
            return await ws.exec(command, cwd);
          } catch (err) {
            return { error: String(err), exitCode: 1, stdout: "", stderr: "" };
          }
        },
      })),

      ...pick("gitClone", createGitCloneTool({
        workspace: {
          sessionId: this.name,
          vfs:       ws.vfs,
          mkdir:     (p) => ws.mkdir(p),
        },
        artifacts: this.env.Artifacts,
      })),

      ...pick("worker_deploy", tool({
        description:
          "Build a Cloudflare Worker from a wrangler.jsonc in /workspace and load it into an " +
          "isolated Dynamic Worker. Repeated calls on the same bundle reuse the warm isolate.",
        inputSchema: z.object({
          config: z.string().describe("Path to wrangler.jsonc, e.g. /workspace/wrangler.jsonc"),
        }),
        execute: async ({ config }) => {
          try {
            return await this.deployer.deploy(config);
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },
      })),

      ...pick("worker_fetch", tool({
        description:
          "Send a fetch() request to the currently-deployed Worker. The argument must be a " +
          "static fetch() call expression — no variables or function calls, just string/number/" +
          "object/array literals.",
        inputSchema: z.object({
          request: z.string().describe(
            "A fetch() call expression, e.g. fetch('https://w/api', { method: 'POST', body: '{}' })",
          ),
        }),
        execute: async ({ request }) => {
          const worker = this.deployer.current;
          if (!worker) {
            return { error: "no worker deployed — call worker_deploy first" };
          }
          let parsed;
          try { parsed = parseFetchCall(request); }
          catch (err) { return { error: `bad fetch call: ${(err as Error).message}` }; }
          try {
            return await fetchAgainstWorker(worker, parsed);
          } catch (err) {
            return { error: String(err) };
          }
        },
      })),
    };
  }

  // ── Sub-agent spawning ─────────────────────────────────────────────
  // Convenience RPCs that spawn a `SubAgent` facet and round-trip a
  // sanity check. Wired so that real delegation tools (research,
  // long-running compilation, parallel work) can be built on top of
  // `this.subAgent(SubAgent, name)` without further plumbing.

  /** Spawn a SubAgent and echo its name back, proving the link works. */
  async spawnAndPing(childName: string): Promise<string> {
    const child = await this.subAgent(SubAgent, childName);
    return child.whoAmI();
  }

  /** Spawn a SubAgent and ask the child for the parent's name. */
  async spawnAndAskParentName(childName: string): Promise<string> {
    const child = await this.subAgent(SubAgent, childName);
    return child.whoIsMyParent();
  }

  /** Returns this agent's DO name. Used as a sanity RPC from children. */
  whoAmI(): string {
    return this.name;
  }

  /**
   * Append a bare user message to the conversation without driving a
   * model turn. Test-only helper — production code uses the chat WS or
   * sub-agent `chat()`. Persists through Session so /messages and
   * /reset behave correctly afterwards.
   */
  async seedUserMessage(text: string): Promise<void> {
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    });
  }

  // ── Thread summary (background) ────────────────────────────────
  //
  // The room view renders a one- or two-sentence summary under each
  // threaded message so users can skim discussions without opening the
  // thread. We always use the Workers AI Kimi model for this so summaries
  // stay consistent (and cheap) even when the chat model is OpenAI.
  //
  // The summary is produced by a *background* scheduled task, not on the
  // request hot path. New activity (user message, assistant turn, seed)
  // calls `kickSummary()`, which idempotently schedules a debounced tick.
  // The tick generates a summary if messages have changed and then
  // exits — it does *not* reschedule itself. Old threads that nobody
  // touches simply stop ticking. The `/summary` endpoint is a pure read
  // of the cached value.

  /** Debounce window between a new message and the summary tick. */
  private static readonly SUMMARY_DEBOUNCE_SEC = 8;

  /** Cached summary blob persisted to storage so it survives eviction. */
  private static readonly SUMMARY_STORAGE_KEY = "thread-summary";

  /** Returns the cached summary. Pure read — never calls the model. */
  private async handleSummary(): Promise<Response> {
    const cached = await this.ctx.storage.get<{ count: number; text: string }>(
      Agent.SUMMARY_STORAGE_KEY,
    );
    return Response.json({
      summary: cached?.text ?? "",
      count:   cached?.count ?? 0,
    }, { headers: { "cache-control": "no-store" } });
  }

  /**
   * Mark the thread as active and (re)arm the background summary tick.
   * Idempotent: rapid-fire messages collapse onto the same scheduled row,
   * so a burst of replies still produces one summary run.
   */
  private async kickSummary(): Promise<void> {
    try {
      await this.schedule(
        Agent.SUMMARY_DEBOUNCE_SEC,
        "runSummary" as keyof this,
        undefined,
        { idempotent: true },
      );
    } catch {
      // Scheduling is best-effort. A missed tick just delays the
      // summary until the next message kicks it again.
    }
  }

  /**
   * Scheduled callback: generate a summary if the message count has
   * advanced since the last run. Exits without rescheduling — the next
   * message will arm a fresh tick via `kickSummary()`. This is how
   * idle threads stop consuming model calls.
   */
  async runSummary(): Promise<void> {
    const count = this.messages.length;
    if (count === 0) return;

    const cached = await this.ctx.storage.get<{ count: number; text: string }>(
      Agent.SUMMARY_STORAGE_KEY,
    );
    if (cached && cached.count === count) return;

    const transcript = renderTranscriptForSummary(this.messages);
    if (!transcript) {
      await this.ctx.storage.put(Agent.SUMMARY_STORAGE_KEY, { count, text: "" });
      return;
    }

    try {
      const kimi = createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
      const { text } = await generateText({
        model: kimi,
        system:
          "You summarise short chat threads for a sidebar preview. Reply with one " +
          "or two plain sentences. The first sentence states the overall topic. " +
          "Add a second sentence only if the current status (resolved, blocked, " +
          "in progress, awaiting input) is worth surfacing. No greetings, no " +
          "bullet points, no markdown.",
        prompt: transcript,
      });
      await this.ctx.storage.put(Agent.SUMMARY_STORAGE_KEY, {
        count,
        text: text.trim(),
      });
    } catch {
      // Swallow — the next message will trigger another attempt. We
      // intentionally don't overwrite the cached summary on failure so
      // a transient model error doesn't blank out a usable preview.
    }
  }
}
/**
 * SubAgent — a Think DO that the top-level `Agent` can spawn via
 * `this.subAgent(SubAgent, name)`. Lives as a facet of its parent, with
 * its own SQLite storage and message history.
 *
 * Currently bare-bones: model selection mirrors the parent and the tool
 * set is empty. Subclass or fill in `getModel()`/`getTools()` when a
 * concrete delegation use-case appears. The class exists today so the
 * runtime binding and migration are already wired — spawning a child
 * doesn't require a redeploy.
 */
export class SubAgent extends Think<Env> {
  override chatRecovery = true;

  /** Returns this sub-agent's DO name. Used as a sanity RPC. */
  whoAmI(): string {
    return this.name;
  }

  /** Returns the parent agent's DO name via `parentAgent(Agent)`. */
  async whoIsMyParent(): Promise<string> {
    const parent = await this.parentAgent(Agent);
    // The parent stub exposes its own `whoAmI()` (defined below on
    // Agent) so the child can read it without any extra glue.
    return parent.whoAmI();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Render a thread's chat history as a plain transcript for summarisation.
 *
 * Strips reasoning/thinking parts and tool calls/results — the summary
 * cares about what the humans and the agent *said*, not the machinery
 * the agent used to get there. Only `text` parts survive.
 *
 * Returns an empty string when there is nothing substantive to summarise.
 */
export function renderTranscriptForSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: ReadonlyArray<any>,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const text = parts
      .filter((p: { type?: unknown }) => p && p.type === "text")
      .map((p: { text?: unknown }) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!text) continue;
    const speaker = m.role === "user"
      ? (m.metadata?.author?.name ?? "User")
      : "Agent";
    lines.push(`${speaker}: ${text}`);
  }
  return lines.join("\n");
}
