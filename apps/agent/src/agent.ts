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
import { tool } from "ai";
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
    }
    return super.onMessage(connection, message);
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
          "ONLY for compilation and build-tool operations. Do not use for file ops; use the file tools.",
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
