/**
 * Agent — a Think-based DO that owns one Slack-style conversation.
 *
 * Inherits from `@cloudflare/think` for the agentic loop, Session-backed
 * message storage (branches, FTS5, non-destructive compaction), durable
 * chat fibers via `chatRecovery`, stream resumption, and the lifecycle
 * hooks. The custom `@cloudflare/workspace` Workspace stays put — it
 * owns the SQLite VFS, the container sync, and the capnweb session.
 *
 * This file only does chat-shaped things: choosing a persona, defining
 * tools, picking a model, and persisting per-turn config. The model call
 * itself is owned by Think.
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
import { Workspace } from "@cloudflare/workspace";
import { runWasm } from "@cloudflare/workspace/worker-sandbox";
import { resolveContainerId } from "./pool.js";
import {
  COMMON_TOOLS,
  DEFAULT_PERSONA,
  fetchAgainstWorker,
  lookupPersona,
  parseFetchCall,
  PERSONAS,
  WorkerDeployer,
  type Persona,
  type ToolName,
} from "./personas/index.js";

const WORKSPACE = "/workspace";


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

  /** Lazily-constructed deployer for the Cloudflare Worker persona. */
  private _deployer?: WorkerDeployer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage:   this.ctx.storage,
      sandbox:   this.env.Sandbox,
      sessionId: this.name,
      resolveSessionId: (id) => resolveContainerId(this.env, id),
    });
    this.workspace.mkdir(WORKSPACE);
  }

  /**
   * Persona persistence is backed by Think's `configure<T>()` /
   * `getConfig<T>()`, which writes to Session's SQLite. Survives
   * hibernation and restarts without per-agent schema setup.
   */
  private get personaId(): string {
    return this.getConfig<{ personaId: string }>()?.personaId ?? DEFAULT_PERSONA.id;
  }

  private setPersonaId(id: string): void {
    this.configure<{ personaId: string }>({ personaId: id });
  }

  private get persona(): Persona {
    return lookupPersona(this.personaId);
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

  // ── Think hooks ─────────────────────────────────────────────────────────

  /** Active persona's system prompt. */
  override getSystemPrompt(): string {
    return this.persona.systemPrompt;
  }

  /**
   * Model selection: OpenAI when `OPENAI_API_KEY` is set, otherwise
   * the Workers AI fallback. Mirrors the old `onChatMessage` picker.
   */
  override getModel() {
    if (this.env.OPENAI_API_KEY) {
      return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(
        this.env.OPENAI_MODEL ?? "gpt-4o-mini"
      );
    }
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
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
        const stat = this.workspace.stat(e.path);
        entries.push({ path: e.path, type: e.type, size: stat?.size ?? 0, mtime: e.mtime });
      }
      return Response.json({ count: entries.length, entries }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset")) {
      await this.clearMessages();
      return Response.json({ cleared: true });
    }

    if (request.method === "GET" && url.pathname.endsWith("/persona")) {
      return Response.json({
        current:   this.persona,
        available: PERSONAS,
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/persona")) {
      const { id } = (await request.json()) as { id: string };
      const p = lookupPersona(id);
      if (p.id !== id) return Response.json({ error: `Unknown persona: ${id}` }, { status: 400 });
      this.setPersonaId(p.id);
      return Response.json({ ok: true, persona: p });
    }

    return new Response("not found", { status: 404 });
  }

  // ---- tools ----

  /**
   * Tools the agentic loop sees this turn. Gated by the active persona:
   * COMMON_TOOLS plus whatever `extraTools` the persona declares. The
   * old `buildTools(persona)` helper was called from a manual
   * `onChatMessage`; under Think this IS the public override Think's
   * loop calls every turn.
   */
  override getTools() {
    return this.buildTools(this.persona);
  }

  /** Introspection RPC: the set of tool names visible to the LLM. */
  activeToolNames(): string[] {
    return Object.keys(this.getTools());
  }

  private buildTools(persona: Persona) {
    const ws = this.workspace;
    const allow = new Set<ToolName>([...COMMON_TOOLS, ...persona.extraTools]);
    const pick = <T extends Record<string, unknown>>(name: ToolName, def: T) =>
      allow.has(name) ? { [name]: def } : {};

    return {
      ...pick("readFile", tool({
        description: "Read the contents of a file",
        inputSchema: z.object({ path: z.string().describe("Absolute path, e.g. /workspace/main.zig") }),
        execute: async ({ path }) => {
          const bytes = ws.readFile(path);
          if (!bytes) return { error: `File not found: ${path}` };
          return { path, content: new TextDecoder().decode(bytes) };
        },
      })),

      ...pick("writeFile", tool({
        description: "Write content to a file, creating parent directories as needed",
        inputSchema: z.object({
          path:    z.string().describe("Absolute path, e.g. /workspace/main.zig"),
          content: z.string().describe("File content"),
        }),
        execute: async ({ path, content }) => {
          ws.writeFile(path, content);
          return { path, bytesWritten: content.length };
        },
      })),

      ...pick("listDirectory", tool({
        description: "List files and directories at a path",
        inputSchema: z.object({ path: z.string().describe("Absolute directory path, e.g. /workspace") }),
        execute: async ({ path }) => ({ path, entries: ws.readdir(path) }),
      })),

      ...pick("stat", tool({
        description: "Get metadata for a file or directory: type, size, mtime",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const s = ws.stat(path);
          if (!s) return { error: `Not found: ${path}` };
          return { path, ...s };
        },
      })),

      ...pick("mkdir", tool({
        description: "Create a directory (including parent directories)",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => { ws.mkdir(path); return { path, created: true }; },
      })),

      ...pick("deleteFile", tool({
        description: "Delete a file or directory (recursive)",
        inputSchema: z.object({ path: z.string().describe("Absolute path to delete") }),
        execute: async ({ path }) => { ws.deleteFile(path); return { path, deleted: true }; },
      })),

      ...pick("findFiles", tool({
        description: "Search for files matching a pattern under a directory",
        inputSchema: z.object({
          directory: z.string().describe("Directory to search under, e.g. /workspace"),
          pattern:   z.string().optional().describe("Substring to match against filename, e.g. '.zig' or '.go'"),
        }),
        execute: async ({ directory, pattern }) => ({
          directory, pattern,
          matches: ws.findFiles(directory, pattern),
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
          matches: ws.grep(pattern, path, { ignoreCase }),
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

      ...pick("run", tool({
        description:
          "Run a compiled WASM binary in an isolated Dynamic Worker. The binary lives at " +
          "/workspace/<name>.wasm. /workspace is preopened as a virtual filesystem; any " +
          "files the program writes under /workspace/* are saved back into the VFS, and " +
          "image files render inline in the chat as previews.",
        inputSchema: z.object({
          command: z.string().describe(
            "Binary name + args, e.g. 'mandelbrot --width 800 --output /workspace/out.png'",
          ),
          stdin: z.string().optional().describe("Optional stdin"),
        }),
        execute: async ({ command, stdin }) => {
          const [name, ...rest] = command.trim().split(/\s+/);
          const wasmPath = `/workspace/${name}.wasm`;
          try {
            return await runWasm({
              workspace: ws,
              loader:    this.env.LOADER,
              wasmPath,
              argv:      [name, ...rest],
              stdin,
            });
          } catch (err) {
            return { error: String(err), exitCode: 1, stdout: "", stderr: "", files: [], images: [] };
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
