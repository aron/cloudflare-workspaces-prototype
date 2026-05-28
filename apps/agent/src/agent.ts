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
import type { ChatResponseResult, StepContext, ToolCallResultContext, TurnContext } from "@cloudflare/think";
import { LoopTracker } from "./loop-tracker.js";
import { stampPartDurations } from "./stamp-tool-durations.js";

import { Think } from "@cloudflare/think";
import { callable } from "agents";
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
import {
  createGitCloneTool,
  createGitCreateRepoTool,
  createGitListReposTool,
  createGitCommitTool,
  createGitPushTool,
  createGitShareTool,
} from "@cloudflare/git-tools";
import { createDoForkRegistry } from "./fork-registry.js";
import type { ForkRegistry } from "@cloudflare/workspace/git";
import {
  createBraveSearchProvider,
  createWebFetchTool,
  createWebSearchTool,
} from "@cloudflare/web-tools";
import { resolveContainerId } from "./pool.js";
import { currentModelId } from "./model.js";
import { readIdentity } from "./identity.js";
import { buildSessionTar } from "./debug-tar.js";
import { shortId } from "./ids.js";
import { guessMimeType } from "./mime.js";
import { resolveOrphanToolCalls } from "./orphan-tools.js";
import { splitStreamingTools } from "./streaming-tools.js";
import { ExecOutputBuffer, type LogEvent } from "./exec-buffer.js";
import { ExecInflight } from "./exec-inflight.js";
import { buildListing, type ListingEntry } from "./file-listing.js";
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

/**
 * Path segments excluded from the post-`exec()` pull. Shared between
 * the Workspace config (which uses it to gate what crosses the wire
 * from the container to the DO) and the system prompt (which tells
 * the model these files won't appear via read/ls/grep/find). Single
 * source of truth so a future addition only needs to be made here.
 *
 * The Workspace matcher treats each entry as a path segment: a name
 * matches when the path contains `/<name>/` or ends with `/<name>`.
 */
const WORKSPACE_IGNORE = ["node_modules"];


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

  /**
   * Per-tool-call abort controllers. Keyed by `toolCallId`, populated when a
   * long-running tool starts and removed when it settles. The cancelToolCall
   * RPC fires the matching controller; `raceWithSignal` then resolves the
   * tool with `{ aborted: true }` so the model loop unwinds without waiting
   * for the underlying workspace call to return.
   */
  private _toolAborts = new Map<string, AbortController>();

  /** Tools that read state but never mutate it — free in the budget. */
  private static readonly READ_ONLY_TOOLS = new Set<string>([
    "read", "ls", "stat", "find", "grep",
    "webfetch", "websearch", "git_list_repos",
  ]);

  /**
   * Tools whose `execute` returns an AsyncIterable that the AI SDK must
   * see *unwrapped* so preliminary chunks reach the UI message stream.
   * Think's default `_wrapToolsWithDecision` awaits the execute, detects
   * AsyncIterable, and drains it down to the last value (so it can run
   * `beforeToolCall` first). That collapses streaming. We override the
   * wrap below to pass these tools through untouched.
   *
   * Trade-off: `beforeToolCall` doesn't fire for streaming tools. We
   * don't use it for anything in this agent.
   */
  private static readonly STREAMING_TOOLS = new Set<string>(["exec"]);

  /**
   * Per-turn reflection budget + duplicate-call tracker. Think's flat
   * `maxSteps` counts every model round-trip equally; this lets cheap
   * exploration (read/grep) run free while still catching agents that
   * thrash on edit/exec or repeat the same call. See loop-tracker.ts.
   */
  private _loop = new LoopTracker({
    readOnlyTools: Agent.READ_ONLY_TOOLS,
    reflectionBudget: 12,
    loopWindow: 30,
    loopThreshold: 3,
    maxReflectionsPerTurn: 1,
  });

  /**
   * Per-turn `toolCallId → durationMs` buffer populated by
   * `afterToolCall`. Consumed by `onChatResponse` to stamp
   * `callDurationMs` onto the persisted assistant message's tool parts.
   *
   * Why a buffer instead of patching the part directly in
   * `afterToolCall`: the AI SDK's `experimental_onToolCallFinish` fires
   * before Think persists the assistant message via
   * `_persistAssistantMessage` (which only runs after the stream ends).
   * Mutating `this.messages` mid-stream would race the
   * `StreamAccumulator` that builds the final message. Stamping in
   * `onChatResponse` is post-persistence, single-threaded, and survives
   * reconnects because the patch is written back through
   * `updateMessageInHistory`.
   *
   * Cleared after each `onChatResponse` so a long-lived agent doesn't
   * accumulate ids forever; durations from earlier assistant messages
   * have already been stamped and don't need to be replayed.
   */
  private _toolDurations = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Patch Think's tool-wrapper to pass streaming tools through without
    // collapsing their AsyncIterable execute. Done as an instance-level
    // monkey patch (rather than a subclass override) because the method
    // is declared private in Think's .d.ts and TypeScript blocks both
    // override and super-call. The runtime function lives on the
    // prototype with a leading underscore; splitStreamingTools wraps
    // the parent implementation in a tool-set splitter that's unit-
    // tested in isolation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    const original = self._wrapToolsWithDecision.bind(this);
    self._wrapToolsWithDecision = splitStreamingTools(Agent.STREAMING_TOOLS, original);
    this.workspace = new Workspace({
      storage:   this.ctx.storage,
      sandbox:   this.env.Sandbox,
      sessionId: this.name,
      resolveSessionId: (id) => resolveContainerId(this.env, id),
      // Drop regenerable subtrees from the post-exec pull so we don't
      // ship megabytes of node_modules through capnweb after every
      // npm install. The bytes still exist on the container side for
      // the next exec() to use; we just don't persist them into the
      // DO's VFS. Sourced from WORKSPACE_IGNORE so the system prompt
      // can advertise the same list to the model — see getSystemPrompt().
      pullIgnore: WORKSPACE_IGNORE,
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

  /**
   * Lazily-built SQL-backed `ForkRegistry`. Lives on the same DO storage
   * the Workspace uses but in its own `_git_forks` table.
   */
  private _forks?: ForkRegistry;
  private _forkRegistry(): ForkRegistry {
    if (!this._forks) {
      const sql = (this.ctx.storage as DurableObjectStorage & { sql: SqlStorage }).sql;
      this._forks = createDoForkRegistry(sql);
    }
    return this._forks;
  }

  onStart() {
    // Pre-warm: kick off container boot in background, don't block.
    this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));
    // Recover in-flight exec processes that were running when the DO
    // last died. Don't block onStart; this can race with new turns and
    // either path tolerates a stale inflight row.
    this.ctx.waitUntil(this._recoverInflightExecs().catch(err => {
      console.warn("[Agent] exec recovery failed:", err);
    }));
  }

  /**
   * Sweep the _exec_inflight table and reconcile each row with the
   * sandbox's view of the process. Three cases:
   *
   *   - sandbox.getProcess returns null     -> process is gone (sandbox
   *     cycled or never had it). Patch the persisted tool part to
   *     output-error with details: "process lost on restart". Clear
   *     the inflight row.
   *   - process completed                    -> patch the part to a
   *     final output-available state built from sandbox logs. Clear.
   *   - process still running                -> reattach, stream the
   *     remaining logs into the persisted part via
   *     updateMessageInHistory, then clear when it exits.
   *
   * Patches go through updateMessageInHistory so subsequent reconnects
   * and future turns see the correct state. Without recovery the
   * orphan-tools safety net (beforeTurn) still rewrites the part to
   * output-error; recovery just gives a nicer result when the process
   * actually finished.
   */
  private async _recoverInflightExecs(): Promise<void> {
    const inflight = this._inflight();
    const rows = inflight.list();
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await this._recoverOneInflightExec(row.toolCallId, row.processId);
      } catch (err) {
        console.warn(`[Agent] recovery for ${row.toolCallId} failed:`, err);
      } finally {
        inflight.clear(row.toolCallId);
      }
    }
  }

  private async _recoverOneInflightExec(toolCallId: string, processId: string): Promise<void> {
    const ws = this.workspace;
    // 1. Probe the sandbox.
    const proc = await ws.getProcess(processId);
    if (!proc) {
      await this._patchExecPart(toolCallId, {
        processId, running: false, stdout: "", stderr: "",
        error: { details: "process lost on restart" },
        exitCode: -1,
      });
      return;
    }

    // 2. Pull whatever logs are still buffered. The sandbox keeps them
    //    even after exit, so this covers both running and completed.
    const buf = new ExecOutputBuffer();
    try {
      const stream = await ws.streamProcessLogs(processId);
      for await (const event of stream as AsyncIterable<LogEvent>) {
        buf.apply(event);
        if (event.type === "exit" || event.type === "error") break;
      }
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      await this._patchExecPart(toolCallId, {
        ...buf.snapshot(processId), error: { details },
      });
      return;
    }
    // Pull dirty files; same rationale as the live tool's finally clause.
    // Failures here mean the VFS stays out of sync with the container until
    // the next exec — log them at warn so the asymmetry is visible instead of
    // silently degrading.
    try {
      await ws.pullDirtyAfter();
    } catch (err) {
      console.warn("[Agent] pullDirtyAfter failed during exec recovery:", err);
    }
    await this._patchExecPart(toolCallId, buf.snapshot(processId));
  }

  /**
   * Walk this.messages, find the assistant message that carries the
   * tool part with matching toolCallId, and patch it to
   * output-available with the supplied snapshot. Persisted via
   * updateMessageInHistory so reconnects and future turns see it.
   */
  private async _patchExecPart(toolCallId: string, snap: unknown): Promise<void> {
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      let touched = false;
      const parts = m.parts.map(p => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ap = p as any;
        if (typeof ap.type === "string" && ap.type.startsWith("tool-") &&
            ap.toolCallId === toolCallId) {
          touched = true;
          return { ...ap, state: "output-available", output: snap };
        }
        return p;
      });
      if (touched) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.updateMessageInHistory({ ...m, parts } as any);
        return;
      }
    }
  }

  // ── Think hooks ───────────────────────────────────────

  /**
   * Single fixed system prompt for the TypeScript / Cloudflare /
   * Agents / Sandbox agent. Specialization comes from skills, which
   * are enumerated in the prompt's <available_skills> block and
   * loaded on demand via the read tool.
   */
  override getSystemPrompt(): string {
    return buildSystemPrompt({ cwd: WORKSPACE, skills: this._skills, threadId: this.name, pullIgnore: WORKSPACE_IGNORE });
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
  override async beforeTurn(ctx?: TurnContext) {
    this.ctx.waitUntil(this.workspace.warmup().catch(() => {}));

    // Patch dangling tool calls before the model sees them. A tool
    // result that never lands (exec timeout, container loss, DO eviction
    // mid-call) leaves the part in `input-available` / `input-streaming`
    // / `approval-requested`. convertToModelMessages then emits the
    // assistant's tool call with no matching tool-result row, the
    // provider rejects it, and the thread wedges. Rewrite those parts
    // to `output-error: cancelled` so the SDK emits a proper result row,
    // and persist the patch so reconnects and future turns see it too.
    const swept = resolveOrphanToolCalls(this.messages);
    if (swept.changed) {
      console.warn(
        `[Agent] patched ${swept.patched.length} orphan tool call(s):`,
        swept.patched,
      );
      for (let i = 0; i < swept.messages.length; i++) {
        const patched = swept.messages[i];
        const original = this.messages[i];
        if (patched !== original) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await this.updateMessageInHistory(patched as any);
        }
      }
    }

    // Reset per-turn budget/loop state at the start of a fresh user
    // turn. Continuation turns (auto-continue after tool result, or
    // our injected reflection itself) keep the counters so the guard
    // works across the whole logical turn.
    if (!ctx?.continuation) this._loop.reset();
    return {
      // Hard ceiling well above the soft budget — the LoopTracker
      // decides when to fire a reflection.
      maxSteps: 60,
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

  /** Feed the LoopTracker after every model step. */
  override onStepFinish(ctx: StepContext): void {
    const calls = (ctx.toolCalls ?? []).map(c => ({
      toolName: c.toolName,
      input: c.input,
    }));
    this._loop.recordStep(calls);
  }

  /**
   * Record the tool call's wall-clock duration so `onChatResponse` can
   * stamp it onto the persisted assistant message's tool part. The AI
   * SDK gives us `durationMs` on both the success and error branches of
   * `ToolCallResultContext`, so we record either way — a failed call's
   * duration is just as interesting to surface as a successful one.
   */
  override afterToolCall(ctx: ToolCallResultContext): void {
    this._toolDurations.set(ctx.toolCallId, ctx.durationMs);
  }

  /**
   * Introspection RPC — returns the bits of TurnConfig that don't
   * require a real model call. Used by tests to assert the persona
   * prompt, ZDR posture, and that a model object is constructable.
   */
  async previewTurnConfig(): Promise<{
    systemPrompt: string;
    providerOptions: Awaited<ReturnType<Agent["beforeTurn"]>>["providerOptions"];
    modelDefined: boolean;
  }> {
    const cfg = await this.beforeTurn();
    return {
      systemPrompt: this.getSystemPrompt(),
      providerOptions: cfg.providerOptions,
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
   * persisted. Two jobs:
   *
   *   1. Stamp `callDurationMs` onto every tool part whose call duration
   *      we recorded in `afterToolCall`. Patches the persisted message
   *      via `updateMessageInHistory` and broadcasts a
   *      `cf_agent_message_updated` frame so live `useAgentChat` clients
   *      see the badge without reloading the room.
   *
   *   2. Refresh the thread summary so the room view's preview reflects
   *      what the agent just said, and run the loop-tracker reflection
   *      injector.
   *
   * The duration-stamping path is wrapped in `try/catch` and logged: it's
   * a display detail, never load-bearing, and a failure here must not
   * block the summary kick or the reflection injector that the room
   * view depends on.
   */
  override onChatResponse(result: ChatResponseResult): void {
    this.ctx.waitUntil(this._stampToolDurations(result).catch(err => {
      console.warn("[Agent] tool duration stamping failed:", err);
    }));
    this.ctx.waitUntil(this.kickSummary());
    this.ctx.waitUntil(this.maybeInjectReflection().catch(err => {
      console.warn("[Agent] reflection injection failed:", err);
    }));
  }

  /**
   * Stamp buffered tool-call durations onto the persisted assistant
   * message and broadcast the update.
   *
   * Only fires the storage write + broadcast when something actually
   * changed — the common case for a model turn with no tool calls is a
   * no-op. The buffer is cleared unconditionally so a continuation turn
   * starts with a clean slate.
   */
  private async _stampToolDurations(result: ChatResponseResult): Promise<void> {
    if (this._toolDurations.size === 0) return;

    const { parts, touched } = stampPartDurations(result.message.parts, this._toolDurations);
    this._toolDurations.clear();
    if (!touched) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = { ...result.message, parts } as any;
    await this.updateMessageInHistory(updated);
    // Think's `updateMessageInHistory` doesn't broadcast — it only
    // refreshes the live cache. Push a MESSAGE_UPDATED frame so connected
    // `useAgentChat` clients see the new field without waiting for the
    // next full-message broadcast.
    this.broadcast(JSON.stringify({
      type: "cf_agent_message_updated",
      message: updated,
    }));
  }

  /**
   * If the LoopTracker says we're over budget or thrashing, append a
   * user-visible reflection prompt to the conversation. This re-enters
   * the turn queue via saveMessages — safe here because Think releases
   * the turn lock before calling onChatResponse.
   */
  private async maybeInjectReflection(): Promise<void> {
    const decision = this._loop.shouldReflect();
    if (!decision) return;
    const text = this._loop.buildReflectionMessage(decision);
    this._loop.markReflected();
    await this.saveMessages([{
      id: shortId(),
      role: "user",
      parts: [{ type: "text", text }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any]);
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

    // GET /files-list?prefix=&limit= — prefix listing for the path
    // autocomplete in the file viewer. Narrower than /vfs (which
    // returns the full snapshot) so the popover can poll cheaply.
    if (request.method === "GET" && url.pathname.endsWith("/files-list")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (prefix.split("/").includes("..")) {
        return new Response("bad prefix", { status: 400 });
      }
      const limitRaw = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1), 100);
      const all: ListingEntry[] = [];
      for (const e of this.workspace.vfs.snapshot().entries) {
        all.push({ path: e.path, type: e.type === "dir" ? "dir" : "file" });
      }
      const result = buildListing(all, prefix, limit);
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }

    // GET /files/<absolute path> — stream a workspace file with a
    // sensible Content-Type. The agent advertises these URLs in chat
    // so the user can view images / download artifacts directly.
    // Path after the /files/ prefix is treated as the absolute VFS
    // path (we re-prepend the leading slash that URL parsing eats).
    const filesPrefix = "/files/";
    const filesIdx = url.pathname.indexOf(filesPrefix);
    const isHead = request.method === "HEAD";
    if ((request.method === "GET" || isHead) && filesIdx !== -1) {
      const rel = url.pathname.slice(filesIdx + filesPrefix.length);
      if (!rel) return new Response("missing path", { status: 400 });
      const abs = decodeURIComponent(rel.startsWith("/") ? rel : `/${rel}`);
      // Reject `..` segments so a crafted URL can't escape the VFS.
      if (abs.split("/").includes("..")) {
        return new Response("bad path", { status: 400 });
      }
      const stat = await this.workspace.stat(abs);
      if (!stat || stat.type !== "file") {
        return new Response("not found", { status: 404 });
      }
      // For HEAD we still want to report content-length, so stat is
      // enough — skip the readFile.
      const filename = abs.slice(abs.lastIndexOf("/") + 1);
      const download = url.searchParams.get("download") !== null;
      const headers: Record<string, string> = {
        "content-type":   guessMimeType(abs),
        "content-length": String(stat.size ?? 0),
        "cache-control":  "private, max-age=0, must-revalidate",
        "content-disposition": download
          ? `attachment; filename="${filename.replace(/"/g, "")}"`
          : `inline; filename="${filename.replace(/"/g, "")}"`,
      };
      if (isHead) return new Response(null, { headers });
      const bytes = await this.workspace.readFile(abs);
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes as BodyInit, { headers });
    }

    if (request.method === "GET" && url.pathname.endsWith("/tar")) {
      const tar = await buildSessionTar({
        agentName: this.name,
        metadata:  {
          agent:      this.name,
          model:     currentModelId(this.env),
          messageCount: this.messages.length,
          capturedAt: new Date().toISOString(),
        },
        messages:  this.messages,
        workspace: this.workspace,
      });
      return new Response(tar as BodyInit, {
        headers: {
          "content-type":        "application/x-tar",
          "content-disposition": `attachment; filename="${this.name}.tar"`,
          "cache-control":       "no-store",
        },
      });
    }

    if (request.method === "GET" && url.pathname.endsWith("/summary")) {
      return this.handleSummary();
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset")) {
      await this.clearMessages();
      return Response.json({ cleared: true });
    }

    // DELETE / — wipe everything (messages, VFS, summary, fork registry).
    // Called by the worker as part of /api/rooms/:id (cascade) and
    // /api/rooms/:id/threads/:tid deletion.
    if (request.method === "DELETE" && (url.pathname === "/" || url.pathname === "")) {
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
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
   * the agent has one persona, so there's no gating. websearch is
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
    // Shared shape for every git tool. Carries the session id (for
    // per-session fork naming), the raw VFS (for isomorphic-git via the
    // workspace fs adapter), an mkdir hook, and a SQLite-backed
    // ForkRegistry so push/share calls remember which fork belongs to
    // this session across DO restarts.
    const gitWorkspace = {
      sessionId: this.name,
      vfs:       ws.vfs,
      mkdir:     (p: string) => ws.mkdir(p),
      forkRegistry: this._forkRegistry(),
    };

    return {
      ...pick("read",  createReadTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("write", createWriteTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("edit",  createEditTool({ store: new WorkspaceFileStore(ws) })),
      ...pick("webfetch", createWebFetchTool({ ai: this.env.AI })),
      ...(this.env.BRAVE_API_KEY
        ? pick("websearch", createWebSearchTool({
            provider: createBraveSearchProvider({ apiKey: this.env.BRAVE_API_KEY }),
          }))
        : {}),

      ...pick("ls", tool({
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

      ...pick("rm", tool({
        description: "Delete a file or directory (recursive)",
        inputSchema: z.object({ path: z.string().describe("Absolute path to delete") }),
        execute: async ({ path }) => { await ws.deleteFile(path); return { path, deleted: true }; },
      })),

      ...pick("find", tool({
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
          "Prefer the dedicated tools first: read/write/edit/ls/stat/" +
          "mkdir/rm/find/grep for file ops, worker_deploy/worker_fetch " +
          "for Cloudflare Workers, run for compiled WASM binaries. " +
          "Primary use: compilation and build-tool invocation (zig, go, npm, etc.). " +
          "Fallback use: after the same dedicated tool has failed at least twice " +
          "in a row on the same input with errors that look like tool-level bugs " +
          "(not user input errors), it is acceptable to drop down to `exec` to " +
          "achieve the same effect \u2014 e.g. `cat`/`sed`/`mv` when `read`/`edit` " +
          "keeps erroring, shell `ls` when the `ls` tool fails. When you do this, " +
          "say so briefly in your response so the human can see the workaround " +
          "and report the underlying bug. Do not use `exec` as a first attempt " +
          "for anything a dedicated tool covers.",
        inputSchema: z.object({
          command: z.string().describe(
            "Build command, e.g. 'zig build-exe /workspace/main.zig -target wasm32-wasi -O ReleaseSmall -femit-bin=/workspace/main.wasm'",
          ),
          cwd: z.string().optional().describe("Working directory, defaults to /tmp"),
        }),
        execute: this._execStreamingTool(ws),
      })),

      ...pick("git_clone", createGitCloneTool({
        workspace: gitWorkspace,
        artifacts: this.env.Artifacts,
      })),
      ...pick("git_create_repo", createGitCreateRepoTool({
        workspace: gitWorkspace,
        artifacts: this.env.Artifacts,
      })),
      ...pick("git_list_repos", createGitListReposTool({
        artifacts: this.env.Artifacts,
      })),
      ...pick("git_commit", createGitCommitTool({
        workspace: gitWorkspace,
      })),
      ...pick("git_push", createGitPushTool({
        workspace: gitWorkspace,
        artifacts: this.env.Artifacts,
      })),
      ...pick("git_share", createGitShareTool({
        workspace: gitWorkspace,
        artifacts: this.env.Artifacts,
      })),

      ...pick("worker_deploy", tool({
        description:
          "Build a Cloudflare Worker from a wrangler.jsonc in /workspace and load it into an " +
          "isolated Dynamic Worker. Repeated calls on the same bundle reuse the warm isolate.",
        inputSchema: z.object({
          config: z.string().describe("Path to wrangler.jsonc, e.g. /workspace/wrangler.jsonc"),
        }),
        execute: async ({ config }, opts) => {
          return this.runCancellable(opts, () => this.deployer.deploy(config), {
            onError: err => ({ ok: false, error: String(err) }),
          });
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
        execute: async ({ request }, opts) => {
          const worker = this.deployer.current;
          if (!worker) {
            return { error: "no worker deployed — call worker_deploy first" };
          }
          let parsed;
          try { parsed = parseFetchCall(request); }
          catch (err) { return { error: `bad fetch call: ${(err as Error).message}` }; }
          return this.runCancellable(opts, () => fetchAgainstWorker(worker, parsed), {
            onError: err => ({ error: String(err) }),
          });
        },
      })),
    };
  }

  // ── Per-tool-call cancellation ───────────────────────────────────────
  //
  // The turn-level Stop button aborts every in-flight call on a thread. That
  // is sometimes too coarse: when a single tool call wedges (a workspace.exec
  // that never returns is the canonical case), we want to fail just that
  // call so the model loop unwinds and the rest of the conversation keeps
  // flowing. Each long-running tool registers an AbortController under its
  // toolCallId here; the cancelToolCall callable just aborts the matching
  // controller. raceWithSignal then resolves the tool with an `aborted`
  // result, the same shape it produces for the turn-level Stop, so the model
  // sees a terminal answer and the queue drains.

  /**
   * Build the streaming exec tool's execute function.
   *
   * Returned function is an async generator: each yield is a cumulative
   * snapshot of the running process. The AI SDK's tool layer emits each
   * preliminary yield as a `tool-output-available` chunk with
   * `preliminary: true` so the UI sees live state; the model only ever
   * sees the final yield. Think's default `_wrapToolsWithDecision`
   * would drain the iterator before the AI SDK sees it; the constructor
   * monkey-patches around that for exec (see STREAMING_TOOLS).
   *
   * Lifecycle:
   *   1. startProcess (pushes DO→container delta first)
   *   2. record toolCallId→processId in the inflight table
   *   3. loop on streamProcessLogs, fold each LogEvent into the buffer,
   *      yield throttled snapshots (every 100 ms, or immediately on
   *      exit/error)
   *   4. on abort: kill SIGTERM, wait briefly, fall through to yield an
   *      aborted snapshot
   *   5. always: clear the inflight row and pull dirty files back into
   *      the VFS so the model sees what the command wrote
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _execStreamingTool(ws: any) {
    const self = this;
    const FLUSH_MS = 100;
    return async function* (
      { command, cwd }: { command: string; cwd?: string },
      opts: { toolCallId: string; abortSignal?: AbortSignal },
    ) {
      const buf = new ExecOutputBuffer();
      const startedAt = Date.now();
      const inflight = self._inflight();

      // 1. Start the process. A failure here is a tool-level error;
      //    yield once and exit.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let proc: any;
      try {
        proc = await ws.startProcess(command, { cwd: cwd ?? "/tmp" });
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        yield buf.snapshot("", { error: { details }, exitCode: -1, durationMs: Date.now() - startedAt });
        return;
      }

      // 2. Record so onStart can recover us if the DO is evicted mid-run.
      inflight.record(opts.toolCallId, proc.id);

      // 3. Stream logs. Yield an initial running snapshot so the UI
      //    transitions to the live view immediately.
      yield buf.snapshot(proc.id);
      let lastFlush = Date.now();

      // Wire turn-level abort to SIGTERM. We don't await the kill — the
      // stream's exit/error event will close the loop naturally.
      const onAbort = () => {
        try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      };
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) onAbort();
        else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const stream = await ws.streamProcessLogs(proc.id, { signal: opts.abortSignal });
        for await (const event of stream as AsyncIterable<LogEvent>) {
          buf.apply(event);
          const now = Date.now();
          const terminal = event.type === "exit" || event.type === "error";
          if (terminal || now - lastFlush >= FLUSH_MS) {
            lastFlush = now;
            yield buf.snapshot(proc.id, { durationMs: now - startedAt });
          }
          if (terminal) break;
        }
      } catch (err) {
        if (opts.abortSignal?.aborted) {
          yield buf.snapshot(proc.id, {
            error: { details: "aborted" },
            exitCode: 143,
            durationMs: Date.now() - startedAt,
          });
        } else {
          const details = err instanceof Error ? err.message : String(err);
          yield buf.snapshot(proc.id, {
            error: { details },
            durationMs: Date.now() - startedAt,
          });
        }
      } finally {
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener("abort", onAbort);
        }
        inflight.clear(opts.toolCallId);
        // Pull files the container wrote back into the VFS. Errors leave the
        // VFS out of sync with the container until the next exec — log them
        // at warn so the asymmetry is visible instead of silently degrading.
        try {
          await ws.pullDirtyAfter();
        } catch (err) {
          console.warn("[Agent] pullDirtyAfter failed after exec:", err);
        }
      }
    };
  }

  /**
   * Lazily build the ExecInflight tracker. The table is created on
   * first access and reused across calls.
   */
  private _inflightCache: ExecInflight | null = null;
  private _inflight(): ExecInflight {
    if (!this._inflightCache) {
      // SqlStorage is structurally compatible with our SqlStorageLike.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._inflightCache = new ExecInflight((this.ctx.storage as any).sql);
      this._inflightCache.ensureTable();
    }
    return this._inflightCache;
  }

  /**
   * Wrap a tool's work so it observes both the turn-level abort signal and a
   * per-call controller keyed by `toolCallId`. The work is started eagerly
   * (we never gate on the signal first) so we don't change the happy-path
   * behaviour of the tool; only the cancellation surface is new.
   */
  private async runCancellable<T>(
    opts: { toolCallId?: string; abortSignal?: AbortSignal } | undefined,
    work: () => Promise<T>,
    handlers: { onError: (err: unknown) => T | { aborted: true; error: string } | Record<string, unknown> },
  ): Promise<T | { aborted: true; error: string } | Record<string, unknown>> {
    const toolCallId = opts?.toolCallId;
    const turnSignal = opts?.abortSignal;
    const local = new AbortController();
    if (toolCallId) this._toolAborts.set(toolCallId, local);
    // Propagate the turn-level abort into the per-call controller so a
    // single listener (local.signal) covers both surfaces.
    const onTurnAbort = () => local.abort(turnSignal?.reason);
    if (turnSignal) {
      if (turnSignal.aborted) local.abort(turnSignal.reason);
      else turnSignal.addEventListener("abort", onTurnAbort, { once: true });
    }
    try {
      return await raceWithSignal(work(), local.signal);
    } catch (err) {
      return handlers.onError(err);
    } finally {
      turnSignal?.removeEventListener("abort", onTurnAbort);
      if (toolCallId) this._toolAborts.delete(toolCallId);
    }
  }

  /**
   * Cancel a specific in-flight tool call by id. No-op when the id has
   * already settled or was never registered (e.g. a fast tool like `read`
   * that doesn't go through `runCancellable`). The matching tool resolves
   * with `{ aborted: true }` shortly after, the model loop sees a terminal
   * answer for that call, and the turn proceeds.
   *
   * The underlying workspace promise is *not* killed — the workspace SDK
   * doesn't accept abort signals — it's allowed to drain in the background.
   */
  @callable()
  async cancelToolCall(toolCallId: string): Promise<{ cancelled: boolean }> {
    const ctrl = this._toolAborts.get(toolCallId);
    if (!ctrl) return { cancelled: false };
    ctrl.abort(new Error("tool call cancelled by user"));
    return { cancelled: true };
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
      id: shortId(),
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
 * Race a tool's work against the turn's abort signal. The container/sandbox
 * APIs we call from `exec`/`worker_deploy`/`worker_fetch` don't all accept
 * an `AbortSignal`, so when the user clicks Stop we resolve the tool call
 * with an `aborted` result and let the underlying work finish in the
 * background. The Think loop sees the abort on the model side regardless,
 * so the turn unwinds even if the container keeps churning briefly.
 */
async function raceWithSignal<T>(
  work:   Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | { aborted: true; error: string }> {
  if (!signal) return work;
  if (signal.aborted) {
    return { aborted: true, error: "tool call cancelled before start" };
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true, error: "tool call cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

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
