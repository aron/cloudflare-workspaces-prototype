/**
 * Agent — AIChatAgent backed by a `Workspace` from @cloudflare/workspace.
 *
 * The Workspace owns the VFS, the container sync, and the capnweb session.
 * This file does only chat-shaped things: choosing a persona, defining tools,
 * picking a model, streaming the response, and persisting messages.
 */
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, pruneMessages, tool, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { Workspace } from "@cloudflare/workspace";
import { runWasm } from "@cloudflare/workspace/worker-sandbox";
import { resolveContainerId } from "./pool.js";
import { resolvePersonaForTurn } from "./mentions.js";
import { currentModelId } from "./model.js";
import { readIdentity } from "./identity.js";
import { extractAuthorFromUpgradeRequest, stampChatFrame, type ChatAuthor } from "./author-stamp.js";
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


export class Agent extends AIChatAgent<Env> {
  readonly workspace: Workspace;

  /** Persona id, persisted to DO storage so it survives hibernation. */
  private personaId: string = DEFAULT_PERSONA.id;

  /** Lazily-constructed deployer for the Cloudflare Worker persona. */
  private _deployer?: WorkerDeployer;

  constructor(...args: ConstructorParameters<typeof AIChatAgent>) {
    super(...(args as [any, any]));
    this.workspace = new Workspace({
      storage:   this.ctx.storage,
      sandbox:   this.env.Sandbox,
      sessionId: this.name,
      resolveSessionId: (id) => resolveContainerId(this.env, id),
    });
    this.workspace.mkdir(WORKSPACE);
    this.personaId = this.loadPersonaId();
  }

  private get persona(): Persona { return lookupPersona(this.personaId); }

  private get deployer(): WorkerDeployer {
    if (!this._deployer) {
      this._deployer = new WorkerDeployer(this.workspace, this.env.LOADER);
    }
    return this._deployer;
  }

  private loadPersonaId(): string {
    const sql = (this.ctx.storage as { sql: SqlStorage }).sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _agent_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const row = [...sql.exec<{ v: string }>(`SELECT v FROM _agent_state WHERE k = 'personaId'`)][0];
    return row?.v ?? DEFAULT_PERSONA.id;
  }

  private savePersonaId(id: string) {
    const sql = (this.ctx.storage as { sql: SqlStorage }).sql;
    sql.exec(`INSERT OR REPLACE INTO _agent_state(k, v) VALUES ('personaId', ?)`, id);
    this.personaId = id;
  }

  onStart() {
    // Pre-warm: kick off container boot in background, don't block.
    this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));
  }

  /**
   * Capture the human's identity from the WS upgrade request and stash it
   * on the connection. We read it back in `onMessage` to stamp incoming
   * user messages with the right `author` metadata — multiple humans can
   * share a thread, so the connection (not the DO) owns the identity.
   *
   * `connection.setState()` is persisted by the agents SDK and survives
   * hibernation, so we don't need to re-resolve on every wake.
   */
  async onConnect(connection: any, ctx: any) {
    const author = extractAuthorFromUpgradeRequest(ctx.request as Request, readIdentity);
    if (author) connection.setState({ author });
    return super.onConnect(connection, ctx);
  }

  async onMessage(connection: any, message: any) {
    // First user chat request — defensively prime the container so it's
    // warm by the time the model finishes and calls exec.
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);
        if (data?.type === "cf_agent_use_chat_request") {
          this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));
        }
      } catch { /* ignore */ }
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
        const stat = this.workspace.stat(e.path);
        entries.push({ path: e.path, type: e.type, size: stat?.size ?? 0, mtime: e.mtime });
      }
      return Response.json({ count: entries.length, entries }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset")) {
      this.saveMessages([]);
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
      this.savePersonaId(p.id);
      return Response.json({ ok: true, persona: p });
    }

    // POST /seed { personaId, roomId, threadId, message } — called by RoomDO
    // when a `@persona` mention mints a thread. Sets the thread's default
    // persona and persists the originating user message as the first turn.
    // Idempotent: re-seeding a thread that already exists is a no-op so the
    // client can safely retry on transient failures.
    if (request.method === "POST" && url.pathname.endsWith("/seed")) {
      const body = await request.json().catch(() => ({})) as {
        personaId?: unknown; roomId?: unknown; threadId?: unknown; message?: unknown;
      };
      const personaId = typeof body.personaId === "string" ? body.personaId : "";
      const message   = body.message;
      if (!personaId || !message || typeof message !== "object") {
        return Response.json({ error: "personaId and message are required" }, { status: 400 });
      }
      const persona = lookupPersona(personaId);
      if (persona.id !== personaId) {
        return Response.json({ error: `Unknown persona: ${personaId}` }, { status: 400 });
      }
      // Idempotency: if the seed message id is already in history, treat as
      // already-seeded and just confirm the current persona.
      const messageId = (message as { id?: unknown }).id;
      const alreadySeeded = typeof messageId === "string"
        && this.messages.some(m => m.id === messageId);
      if (!alreadySeeded) {
        this.savePersonaId(persona.id);
        // Cast through `any` — saveMessages accepts the AI SDK UIMessage shape;
        // we trust the caller (RoomDO) to send a well-formed AppMessage.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.saveMessages([message as any]);
      }
      return Response.json({ ok: true, seeded: !alreadySeeded, personaId: persona.id });
    }

    return new Response("not found", { status: 404 });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const modelId = currentModelId(this.env);
    const model = this.env.OPENAI_API_KEY
      ? createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(modelId)
      : createWorkersAI({ binding: this.env.AI })(modelId);

    const activePersona = lookupPersona(resolvePersonaForTurn(this.messages, this.personaId));
    const result = streamText({
      abortSignal: options?.abortSignal,
      model,
      providerOptions: {
        openai: {
          reasoningEffort:  (this.env as any).OPENAI_REASONING_EFFORT ?? "medium",
          reasoningSummary: "auto",
          // Zero Data Retention orgs can't reference server-stored reasoning
          // by id. Disable storage and round-trip encrypted reasoning inline.
          store:   false,
          include: ["reasoning.encrypted_content"],
        },
      },
      // Per-turn persona resolution: the most recent user `@mention` wins,
      // falling back to the thread's default persona. Both system prompt
      // and tool surface follow the same persona for the current turn.
      system:   activePersona.systemPrompt,
      messages: pruneMessages({
        messages:  await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message",
      }),
      stopWhen: stepCountIs(20),
      tools:    this.buildTools(activePersona),
    });

    return result.toUIMessageStreamResponse();
  }

  // ---- tools ----

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
}
