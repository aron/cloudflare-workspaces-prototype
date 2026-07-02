/**
 * Agent - a Think-based DO that owns one Slack-style conversation.
 *
 * Inherits from `@cloudflare/think` for the agentic loop, Session-backed
 * message storage (branches, FTS5, non-destructive compaction), durable
 * chat fibers via `chatRecovery`, stream resumption, and the lifecycle
 * hooks. The custom `@cloudflare/workspace` Workspace stays put - it
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
 * set by default - fill in per use case).
 */
import type { ChatResponseResult, StepContext, ToolCallResultContext, TurnContext } from "@cloudflare/think";
import type { ChatErrorClassification, ContextOverflowConfig, Session } from "@cloudflare/think";
import { defaultContextOverflowClassifier } from "@cloudflare/think";
import { LoopTracker } from "./loop-tracker.js";
import { stampPartDurations } from "./stamp-tool-durations.js";
import { APP_DO_NAME } from "./app.js";
import {
  buildSnippet,
  extractMentionedUserIds,
  log,
} from "./notify.js";

import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { callable } from "agents";
import { generateText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  type DurableObjectStorageLike,
  Workspace,
  type WorkspaceBackend,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { createAssets } from "@cloudflare/workspace/assets";
import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { createCloudflareObserver } from "@cloudflare/workspace/observe/cloudflare";
import { tracing } from "cloudflare:workers";
import { resolveContainerId, releaseContainer } from "./pool.js";
import type { Sandbox } from "./sandbox.js";
import { adaptForFsTools } from "./workspace-adapter.js";

import {
  createApplyPatchTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  WorkspaceFileStore,
  type FileStore,
} from "@cloudflare/fs-tools";
import {
  createBraveSearchProvider,
  createWebFetchTool,
  createWebSearchTool,
} from "@cloudflare/web-tools";
import { currentModelId } from "./model.js";
import {
  COMPACT_AFTER_TOKENS,
  PROACTIVE_HEADROOM,
  PROACTIVE_MAX_INPUT_TOKENS,
  createTracedCompaction,
} from "./compaction.js";
import {
  type SchedulePayload,
  type StoredScheduleView,
  ScheduleInputError,
  describeSchedules,
  frameScheduledPrompt,
  resolveWhen,
  scheduleToolSchema,
} from "./schedule-tool.js";
import {
  CLOUDFLARE_MCP_URL,
  type CloudflareConnStatus,
  type McpServerView,
  cloudflareServerId,
  createCloudflareOAuthProvider,
  describeConnection,
  gateCloudflareTools,
  lastUserAuthorId,
  pollCloudflareReady,
} from "./cloudflare-mcp.js";
import { type AgentMcpOAuthProvider, normalizeServerId } from "agents";
import { readIdentity } from "./identity.js";
import { shortId } from "./ids.js";
import { guessMimeType } from "./mime.js";
import { resolveOrphanToolCalls } from "./orphan-tools.js";
import { splitStreamingTools } from "./streaming-tools.js";
import { buildExecToolError, buildExecToolOutput } from "./exec-result.js";
import { buildListing, type ListingEntry } from "./file-listing.js";
import { extractAuthorFromUpgradeRequest, stampChatFrame, type ChatAuthor } from "./author-stamp.js";
import { buildSystemPrompt, buildWorkerSystemPrompt, type Skill } from "./system-prompt.js";
import { discoverSkills } from "./skills.js";
import { fetchProjectInstructions } from "./project-instructions.js";
import { trace, redactSecrets } from "./tracing.js";
import { buildSessionTar } from "./debug-tar.js";

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

/**
 * Decide whether the Workspace should be constructed with an assets
 * client wired in. Two required env vars and one "endpoint source"
 * (either an account id or an explicit endpoint). All three must
 * resolve to non-empty strings; the wrangler.jsonc `vars` block
 * ships them as empty strings so the names are visible to dev, and
 * the deployment overrides them with secrets.
 *
 * Mirrors the same gate `examples/think` uses for its `share` tool.
 */
function hasAssetsConfig(env: Env): boolean {
  return Boolean(
    env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      (env.CLOUDFLARE_ACCOUNT_ID || env.R2_ENDPOINT),
  );
}


export class Agent extends Think<Env> {
  /** Wrap each chat turn in a runFiber so streams survive DO eviction. */
  override chatRecovery = true;

  /** Max tool-call rounds per turn (preserves stepCountIs(20) from old impl). */
  override maxSteps = 20;

  /**
   * The Workspace lives *on this DO*, backed by `ctx.storage`.
   * The capnweb session to wsd runs across DO RPC to a Sandbox
   * container-host chosen by the warm pool. See `#backend` below.
   *
   * Stored as a private field; we never override Think's public
   * `workspace` slot because Think types it against its own
   * `WorkspaceLike` shape (the @cloudflare/shell one) which is a
   * different surface. The Think default tools that consult it
   * are inert here - `getTools()` doesn't include any of them and
   * `workspaceBash` is off - so nothing in the Think baseline
   * actually reads `.workspace`.
   */
  readonly #workspace: Workspace;

  /**
   * The Cloudflare container backend. Its `container: () => ...`
   * factory runs once per `connect()`, so each fresh dial can pick
   * a different Sandbox UUID - mid-session container churn is the
   * pool's problem, not ours.
   */
  readonly #backend: CloudflareContainerBackend;

  /** Cached skill metadata enumerated in the system prompt. */
  private _skills: Skill[] = [];

  /**
   * Cached project-instructions document, fetched from
   * `<SKILLS bucket>/AGENTS.md`. Inlined into `<project_context>` on
   * every turn, mirroring how pi handles its own AGENTS.md.
   *
   * Three sentinels:
   *   - `undefined` - not fetched yet (cold DO, warmup hasn't run).
   *   - `null`      - fetched, but missing/empty/oversized.
   *   - string      - fetched and ready to inline.
   *
   * `beforeTurn` collapses `undefined` to one of the other two by
   * blocking on a fetch, the same way it does for skills.
   */
  private _projectInstructions: string | null | undefined = undefined;

  /** Room the thread lives in. Hydrated lazily from storage; set on seed. */
  private _roomId: string | null = null;

  /** Cached room name for use in mention notifications. Hydrated on seed. */
  private _roomName: string | null = null;

  /** Storage keys for the cached room fields. */
  private static readonly ROOM_ID_STORAGE_KEY   = "thread-room-id";
  private static readonly ROOM_NAME_STORAGE_KEY = "thread-room-name";

  /**
   * Per-tool-call abort controllers. Keyed by `toolCallId`, populated when a
   * long-running tool starts and removed when it settles. The cancelToolCall
   * RPC fires the matching controller; `raceWithSignal` then resolves the
   * tool with `{ aborted: true }` so the model loop unwinds without waiting
   * for the underlying workspace call to return.
   */
  private _toolAborts = new Map<string, AbortController>();

  /** Tools that read state but never mutate it - free in the budget. */
  private static readonly READ_ONLY_TOOLS = new Set<string>([
    "read", "ls", "stat", "find", "grep",
    "webfetch", "websearch",
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
    // Workspace lives in this Agent DO; the backend dials a warm-pool
    // Sandbox DO that owns only ctx.container, and reaches it across
    // Workers RPC through the Sandbox's `getWorkspaceContainer()`
    // method (installed by `withWorkspaceContainer` in sandbox.ts).
    //
    // We previously shipped a fork of this backend
    // (`CrossDOContainerBackend`) because alpha.6's container API
    // returned Fetchers from `host.port(8080)` and Fetchers don't
    // survive a cross-DO Workers RPC hop. alpha.9's container API
    // routes everything through `host.fetchPort(...)`, which
    // executes the fetch inside the container-owning Sandbox DO and
    // returns a plain Response - the exact pattern our fork
    // invented. We can drop the fork and use the upstream backend
    // directly across the cross-DO boundary.
    this.#backend = new CloudflareContainerBackend({
      id: "container",
      // Per-dial factory. resolveContainerId returns the warm-pool
      // UUID for this session; the backend re-invokes us on every
      // reconnect, so a Sandbox eviction or container restart
      // upstream transparently re-picks via the pool.
      container: async () => {
        const uuid = await resolveContainerId(this.env, this.name);
        return this.env.Sandbox.get(this.env.Sandbox.idFromName(uuid));
      },
      // Identifies *this* DO so wsd's outbound /ws upgrade dials
      // back here (see fetch() override below).
      workspace: { binding: "Agent", id: this.ctx.id.toString() },
    });
    // Two backends, tiered by cost. The order matters: the first
    // entry is the workspace's default backend, picked when an exec
    // call doesn't name one. We want the cheap one default - the
    // worker backend boots an isolate in tens of ms and runs the
    // textual command set (cat / grep / sed / awk / jq / git) for
    // free. The container is reserved for npm / node / language
    // toolchains the model explicitly opts into via `backend:
    // 'container'`.
    //
    //   [0]  WorkerBackend             id: 'shell'      (default)
    //   [1]  CloudflareContainerBackend id: 'container'  (warm pool)
    //
    // env.LOADER is optional at construction time because the agent-
    // suite vitest fixtures run against a stripped wrangler config
    // without a `worker_loaders` binding (the private-beta binding
    // isn't surfaced by vitest-pool-workers, and tests never exec).
    // When the loader binding isn't there, the shell backend isn't
    // constructed and the container takes the default slot so the
    // workspace still boots; in prod LOADER is present and the
    // shell takes the lead.
    const backends: WorkspaceBackend[] = [];
    if (this.env.LOADER) {
      backends.push(
        new WorkerBackend({
          id: "shell",
          loader: this.env.LOADER,
          workspace: { binding: "Agent", id: this.ctx.id.toString() },
          ctx: this.ctx,
        }),
      );
    }
    backends.push(this.#backend);
    this.#workspace = new Workspace({
      // ctx.storage.sql.exec returns a narrower row type than
      // DurableObjectStorageLike declares; the runtime shape
      // matches. Cast through unknown to bypass invariance.
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends,
      // Route every workspace op through the Workers Observability
      // user-tracing surface. With `observability.traces.enabled:
      // true` in wrangler.jsonc, spans land in the dashboard
      // alongside the runtime's automatic fetch + binding spans.
      // `tracing` may be undefined in environments without the
      // user-tracing feature flag (e.g. the agent-suite vitest
      // pool); `createCloudflareObserver` degrades to a no-op.
      observer: createCloudflareObserver({ tracing }),
      // Wire the assets client when R2 S3 credentials are present.
      // The worker backend registers an `assets publish <path>` shell
      // command unconditionally; without this clause the command
      // surfaces an RPC error the first time the model invokes it.
      // When credentials are unset the command still registers but
      // its body reports "publishing is not configured for this
      // workspace" — a clean refusal instead of a crash.
      //
      // The bucket name passed to `s3.bucket` is the *R2* bucket
      // (matches `bucket_name` in wrangler.jsonc), not the binding
      // name; the presigner builds canonical S3 URLs against it. We
      // pin `"hackspace-assets"` to match the binding declaration
      // above and avoid threading another env var.
      ...(hasAssetsConfig(this.env)
        ? {
            assets: (ws: Workspace) =>
              createAssets({
                ws,
                bucket: this.env.ASSETS,
                s3: { bucket: "hackspace-assets" },
                env: this.env as unknown as Record<string, string | undefined>,
              }),
          }
        : {}),
      // Wire the Cloudflare Artifacts binding when present. The
      // worker backend registers an `artifact` custom command in the
      // shell backend so `exec({ command: 'artifact create ...' })`
      // dispatches through the artifacts CLI without going out to the
      // public network. Without the binding the command is absent and
      // the model is not told about it (the exec tool description
      // only mentions it when ARTIFACTS is bound).
      ...(this.env.ARTIFACTS
        ? {
            artifacts: {
              binding: this.env.ARTIFACTS,
              sessionId: this.name,
            },
          }
        : {}),
    });
    this.ctx.blockConcurrencyWhile(async () => {
      this._roomId   = (await this.ctx.storage.get<string>(Agent.ROOM_ID_STORAGE_KEY))   ?? null;
      this._roomName = (await this.ctx.storage.get<string>(Agent.ROOM_NAME_STORAGE_KEY)) ?? null;
    });
  }

  /**
   * Worker-routed fetch handler. wsd dials back into the Agent DO
   * over the loopback `WorkspaceProxy` egress with path `/ws` to
   * upgrade the capnweb session. Forward those upgrades to the
   * backend; defer everything else to the agents/partyserver base
   * class so chat WS upgrades, RPC routing, and onRequest dispatch
   * keep working.
   */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ws") {
      return this.#backend.handleFetch(request);
    }
    return super.fetch(request);
  }

  /**
   * Bring the Workspace up if it isn't already - the backend's
   * `connect()` runs the first time, subsequent calls return the
   * cached handle. Failures bubble up to the caller.
   *
   * Returns the local Workspace, not a stub: the Agent owns the
   * instance directly, so fs / shell calls are in-isolate (no
   * DO RPC hop). The `fs` and `shell` getters are the same shape
   * the old `WorkspaceStub` exposed, so existing call sites work
   * unchanged.
   *
   * Private because the public RPC method below (`getWorkspace`)
   * returns the stub shape that WorkspaceServiceProxy expects -
   * we don't want callers reaching across the RPC boundary to grab
   * the live Workspace and accidentally serializing it.
   */
  private async _localWorkspace(): Promise<Workspace> {
    await this.#workspace.ready();
    return this.#workspace;
  }

  /**
   * Public RPC entry point reachable through WorkspaceServiceProxy.
   * The worker backend's shell isolate calls
   * `env.HOST.getWorkspace()` per exec; the proxy resolves it to
   * `this.env.Agent.get(thisId).getWorkspace()` on the host side,
   * lands inside this DO's own request context, and returns a
   * `WorkspaceStub` whose `.fs` / `.shell` calls are normal Workers
   * RPC. Returning the live Workspace instance here would fail with
   * "Could not serialize object of type Workspace" on the way out.
   */
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  /**
   * Best-effort warmup. Hits the warm pool to mint / claim a
   * Sandbox UUID, dials it, and brings the workspace up. Failures
   * are swallowed at call sites (they're all
   * `ctx.waitUntil(...).catch(() => {})`).
   */
  private async warmupWorkspace(): Promise<void> {
    await this._localWorkspace();
  }

  onStart() {
    // Configure the MCP OAuth popup callback: after the user authorizes their
    // Cloudflare account the redirect lands here; return a tiny page that
    // closes the popup. Failures surface as plain text.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response(
            "<!doctype html><script>window.close()</script>Cloudflare access authorized - you can close this window.",
            { headers: { "content-type": "text/html" }, status: 200 },
          );
        }
        return new Response(
          `Cloudflare authorization failed: ${result.authError ?? "unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 },
        );
      },
    });
    // Pre-warm the container in the background. The new exec API
    // doesn't support reattach-to-running-process across DO
    // evictions, so the old _recoverInflightExecs path is gone; a
    // wedged exec is now the user's Stop button to clear.
    this.ctx.waitUntil(this.warmupWorkspace().catch(() => {}));
    // Skills discovery runs directly against the R2 bucket. Before
    // the workspace-next port this rode the R2Mount in the Workspace;
    // the new package doesn't expose that surface, so we hit R2
    // directly and let the system prompt render the result. Failures
    // are swallowed - an empty skill list is preferable to a turn that
    // never starts.
    this.ctx.waitUntil(
      (async () => {
        try {
          this._skills = await discoverSkills(this.env.SKILLS);
        } catch {
          this._skills = [];
        }
      })(),
    );
    // Project-instructions fetch - same shape as skills discovery,
    // same swallow-failures contract. `_projectInstructions` stays
    // `undefined` if the request never completes; `beforeTurn` will
    // block on a fresh fetch in that case.
    this.ctx.waitUntil(
      (async () => {
        try {
          this._projectInstructions = await fetchProjectInstructions(this.env.SKILLS);
        } catch {
          this._projectInstructions = null;
        }
      })(),
    );
  }

  /* Removed: exec inflight recovery.
   *
   * The old @cloudflare/workspace exposed startProcess /
   * streamProcessLogs / getProcess so a DO that died mid-exec could
   * reattach to a still-running command on the next start. The
   * next-branch WorkspaceShell only exposes a result-shaped exec
   * surface (the underlying handle is a stream, but it's not
   * carried across the DO/Sandbox RPC boundary today). Reattach is
   * therefore unimplementable.
   *
   * If a turn wedges across a DO eviction the persisted tool part
   * is left in `input-streaming`; `resolveOrphanToolCalls` in
   * `beforeTurn` patches those to output-error: cancelled so the
   * next model call sees a terminal answer for the part and the
   * thread unwedges.
   */
  // ── Think hooks ───────────────────────────────────────

  /**
   * Single fixed system prompt for the TypeScript / Cloudflare /
   * Agents / Sandbox agent. Specialization comes from skills, which
   * are enumerated in the prompt's <available_skills> block and
   * loaded on demand via the read tool.
   */
  override getSystemPrompt(): string {
    return buildSystemPrompt({
      cwd:        WORKSPACE,
      skills:     this._skills,
      threadId:   this.name,
      roomId:     this._roomId ?? "",
      pullIgnore: WORKSPACE_IGNORE,
      baseUrl:    (this.env as { APP_BASE_URL?: string }).APP_BASE_URL ?? "",
      originator: this.originatorFromMessages(),
      projectInstructions: this._projectInstructions ?? undefined,
      editToolName: this.env.OPENAI_API_KEY ? "apply_patch" : "edit",
    });
  }

  /**
   * Walk message history for the first user message and surface its author
   * as the thread originator. Returns undefined when there is no user
   * message yet (e.g. a freshly-created Agent DO that hasn't been seeded).
   */
  private originatorFromMessages(): { userId: string; name: string } | undefined {
    for (const m of this.messages) {
      if (m.role !== "user") continue;
      const meta = (m as { metadata?: { author?: { kind?: string; id?: string; name?: string } } }).metadata;
      const a = meta?.author;
      if (a && a.kind === "user" && typeof a.id === "string" && typeof a.name === "string") {
        return { userId: a.id, name: a.name };
      }
    }
    return undefined;
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
   * Register auto-compaction on the Session. Called once by Think during
   * `onStart`.
   *
   *  - `onCompaction` supplies HOW to summarize — the reference compaction
   *    function from the Session package, wrapped in an `agent.compaction`
   *    trace span (see compaction.ts) so every compaction is observable.
   *  - `compactAfter` supplies WHEN — a between-turns token threshold at ~80%
   *    of the gpt-5.5 context window, checked after each appended message.
   *
   * The in-turn proactive guard and the reactive backstop are configured via
   * `contextOverflow` below; all three layers reuse this one compaction fn.
   */
  override configureSession(session: Session): Session {
    return session
      .onCompaction(
        createTracedCompaction({
          // resolveModel() (think 0.12.0+) yields a concrete LanguageModel even
          // if getModel() returns a bare id string — the documented path for
          // side inference like compaction's generateText call.
          model: () => this.resolveModel(),
          threadId: this.name,
        }),
      )
      .compactAfter(COMPACT_AFTER_TOKENS)
      .onCompactionError((err) => {
        console.warn(
          `[Agent] auto-compaction failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * Handle a turn that overflows the context window mid-flight.
   *
   *  - `proactive`: before each step, if the previous step's reported
   *    `usage.inputTokens` crosses `maxInputTokens * headroom`, compact in
   *    place and continue — heading off the provider rejection.
   *  - `reactive`: if a turn still fails with a context-overflow error,
   *    discard the partial, `session.compact()`, and re-run the turn.
   *
   * Both reuse the compaction fn registered in `configureSession`.
   */
  override contextOverflow: ContextOverflowConfig = {
    reactive: true,
    maxRetries: 1,
    proactive: {
      maxInputTokens: PROACTIVE_MAX_INPUT_TOKENS,
      headroom: PROACTIVE_HEADROOM,
      maxCompactions: 1,
    },
  };

  /**
   * Map provider errors to Think's semantic categories so `contextOverflow`
   * can act on context-window rejections. Uses the package's default
   * classifier, which matches the overflow error strings of the common
   * providers (OpenAI `context_length_exceeded`, etc.).
   */
  override classifyChatError(error: unknown): ChatErrorClassification | void {
    return defaultContextOverflowClassifier(error);
  }

  // -- Cloudflare MCP (per-user OAuth) --------------------------------

  /**
   * Override the framework's OAuth provider factory so Cloudflare MCP tokens
   * are stored per-user in the dedicated MCP_TOKENS KV namespace (via the split
   * storage adapter) rather than this DO's local storage. The provider derives
   * which user from its own serverId ("cloudflare-<userId>"), which the
   * framework assigns right after construction - including on restore-on-wake.
   * Transient OAuth flow state (state nonce, PKCE verifier) still lives in
   * DO-local storage for strong consistency.
   */
  override createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    if (this.env.MCP_TOKENS) {
      return createCloudflareOAuthProvider({
        kv: this.env.MCP_TOKENS,
        local: this.ctx.storage,
        callbackUrl,
      });
    }
    return super.createMcpOAuthProvider(callbackUrl);
  }

  /**
   * Ensure a Cloudflare MCP connection exists for `userId`, returning its
   * status. addMcpServer is idempotent per (name, url, id): a ready server
   * short-circuits, an authenticating one returns the existing auth URL, and a
   * fresh call starts the OAuth flow. The per-user id means the framework
   * persists + restores each user's connection independently and namespaces
   * their tools, so beforeTurn can gate a turn to just this user's tools.
   */
  private async ensureCloudflareConnection(
    userId: string,
  ): Promise<CloudflareConnStatus> {
    if (!this.env.MCP_TOKENS) return { state: "disconnected" };
    const callbackHost = (this.env as { APP_BASE_URL?: string }).APP_BASE_URL;
    try {
      const res = await this.addMcpServer("cloudflare", CLOUDFLARE_MCP_URL, {
        id: cloudflareServerId(userId),
        ...(callbackHost ? { callbackHost } : {}),
      });
      if (res.state === "authenticating") {
        return { state: "authenticating", authUrl: res.authUrl ?? null };
      }
      return { state: "ready" };
    } catch (err) {
      return {
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Read one user's Cloudflare connection status from the MCP snapshot. */
  private cloudflareStatusFor(userId: string): CloudflareConnStatus {
    const id = normalizeServerId(cloudflareServerId(userId));
    const servers = this.getMcpServers().servers as Record<
      string,
      McpServerView
    >;
    return describeConnection(servers[id]);
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
    return trace("agent.beforeTurn", {
      "hackspace.thread_id": this.name,
      "hackspace.continuation": ctx?.continuation ?? false,
    }, async (span) => {
      span.set("hackspace.messages", () => this.messages.length);
      this.ctx.waitUntil(this.warmupWorkspace().catch(() => {}));

      // Materialise the skill list before the prompt builder runs. The
      // discovery itself is kicked off in `onStart`, but `beforeTurn`
      // can fire before that finishes (or in tests, where `onStart`
      // hasn't been called yet on the fresh DO). Awaiting here adds at
      // most one R2 `list` round-trip on a cold turn; subsequent turns
      // reuse the cached array.
      if (this._skills.length === 0) {
        try {
          this._skills = await discoverSkills(this.env.SKILLS);
        } catch {
          // Leave _skills empty so the system prompt still renders.
        }
      }

      // Same lazy materialisation for the AGENTS.md document. We
      // distinguish "not fetched yet" (undefined) from "fetched, not
      // present" (null) so a missing file doesn't trigger a fresh R2
      // fetch on every turn.
      if (this._projectInstructions === undefined) {
        try {
          this._projectInstructions = await fetchProjectInstructions(this.env.SKILLS);
        } catch {
          this._projectInstructions = null;
        }
      }

      // Patch dangling tool calls before the model sees them. A tool
      // result that never lands (exec timeout, container loss, DO eviction
      // mid-call) leaves the part in `input-available` / `input-streaming`
      // / `approval-requested`. convertToModelMessages then emits the
      // assistant's tool call with no matching tool-result row, the
      // provider rejects it, and the thread wedges. Rewrite those parts
      // to `output-error: cancelled` so the SDK emits a proper result row,
      // and persist the patch so reconnects and future turns see it too.
      const swept = resolveOrphanToolCalls(this.messages);
      span.set("hackspace.orphan_patches", () => swept.patched.length);
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

      // Cloudflare MCP: connect (or refresh) the last speaker's per-user
      // connection, then splice their READY `search`/`execute` tools into this
      // turn. `beforeTurn` runs AFTER Think assembles ctx.tools, so a
      // connection that only just became READY here would otherwise miss the
      // current turn - we inject it via the additive TurnConfig.tools instead.
      // Best-effort: a failure must never block the turn; the `cloudflare`
      // tool's status/connect commands surface auth problems to the user.
      const cfUserId = lastUserAuthorId(this.messages as never);
      let cfTools: Record<string, unknown> = {};
      if (cfUserId && this.env.MCP_TOKENS) {
        try {
          const status = await this.ensureCloudflareConnection(cfUserId);
          if (status.state === "ready") {
            // Only this user's server, so we never pull in another user's tools.
            const serverId = normalizeServerId(cloudflareServerId(cfUserId));
            cfTools = this.mcp.getAITools({ serverId }) as Record<
              string,
              unknown
            >;
          }
        } catch { /* non-fatal */ }
      }

      // Gate Cloudflare MCP tools to the last speaker. The tool set the model
      // sees is the assembled ctx.tools PLUS anything we inject above; every
      // authorized user's already-connected tools also auto-merge into
      // ctx.tools, so we allowlist only the current user's (plus all
      // non-Cloudflare tools) via activeTools, so B can't act through A's
      // Cloudflare account. Only set when Cloudflare tools are actually present
      // (an empty allowlist would disable every tool).
      const unionToolKeys = [
        ...(ctx?.tools ? Object.keys(ctx.tools) : []),
        ...Object.keys(cfTools),
      ];
      const hasCloudflareTools = unionToolKeys.some((k) =>
        k.startsWith("tool_cloudflare"),
      );
      const activeTools = hasCloudflareTools
        ? gateCloudflareTools(unionToolKeys, cfUserId)
        : undefined;

      return {
        // Hard ceiling well above the soft budget - the LoopTracker
        // decides when to fire a reflection.
        maxSteps: 60,
        // Additive: merged on top of the assembled tool set (Think merges
        // config.tools over ctx.tools). Empty object is a no-op.
        ...(Object.keys(cfTools).length > 0
          ? { tools: cfTools as never }
          : {}),
        ...(activeTools ? { activeTools } : {}),
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
    });
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
   * `ToolCallResultContext`, so we record either way - a failed call's
   * duration is just as interesting to surface as a successful one.
   */
  override afterToolCall(ctx: ToolCallResultContext): void {
    this._toolDurations.set(ctx.toolCallId, ctx.durationMs);
  }

  /**
   * Introspection RPC - returns the bits of TurnConfig that don't
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
      // A user reply arrived - arm the background summary tick. Idempotent,
      // so multiple frames in quick succession collapse onto one schedule.
      this.ctx.waitUntil(this.kickSummary());
      // Mirror the room's behaviour: a user message bumps the activity tip
      // so other tabs/users see an unread badge on this thread.
      this.postActivity();
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
  override onChatResponse(result: ChatResponseResult): void | Promise<void> {
    // Span shape: one span per finished turn, covering the synchronous
    // fanout that schedules the four background tasks. The tasks
    // themselves keep running after the span closes (they're
    // `waitUntil`-attached, not awaited here) - we accept that the
    // span's duration only measures the dispatch, not the work, in
    // exchange for keeping `onChatResponse` non-blocking. The
    // individual background tasks (stamp / summary / reflection /
    // notify) get their own spans further down so the work is still
    // observable, just not nested under this one.
    return trace("agent.onChatResponse", {
      "hackspace.thread_id": this.name,
      "hackspace.status": result.status,
      "hackspace.continuation": result.continuation,
    }, async (span) => {
      const parts = (result.message?.parts ?? []) as Array<{ type?: string }>;
      span.set("hackspace.parts", () => parts.length);
      span.set("hackspace.tool_calls", () => parts.filter(p => typeof p?.type === "string" && p.type.startsWith("tool-")).length);
      if (result.status === "error" && result.error) {
        span.setError(new Error(result.error));
      }
      this.ctx.waitUntil(this._stampToolDurations(result).catch(err => {
        console.warn("[Agent] tool duration stamping failed:", err);
      }));
      this.ctx.waitUntil(this.kickSummary());
      // Only check the loop budget when the turn is still in progress
      // (continuation === true means the model just called tools and is
      // about to loop). When continuation is false the agent has already
      // written its final text and stopped — injecting a reflection at
      // that point starts an unwanted new turn instead of steering the
      // current one.
      if (result.continuation) {
        this.ctx.waitUntil(this.maybeInjectReflection().catch(err => {
          console.warn("[Agent] reflection injection failed:", err);
        }));
      }
      this.ctx.waitUntil(this.maybeNotifyMentions(result).catch(err => {
        log("warn", "agent mention notifications failed", { error: (err as Error).message });
      }));
      // Bump the activity tip so room sidebars light up an unread badge on
      // any tab that isn't currently focused on this thread.
      this.postActivity();
    });
  }

  /**
   * Scan the just-finished assistant message for `<user:ID>` tokens and POST
   * a Google Chat ping for each mentioned user that has a Google Chat ID on
   * file. No-op when `GCHAT_WEBHOOK_URL` isn't configured. Skips notifying
   * the thread originator-as-author would be a no-op anyway (the assistant
   * isn't a user), so we don't filter on that.
   */
  /**
   * Notify the App DO that this thread just received a message (user or
   * assistant). The App keeps the canonical tip used by sidebar unread
   * badges. Best-effort under waitUntil - a failure here must not affect
   * the chat turn that just landed.
   *
   * No-op when we don't yet know the parent roomId (pre-seed). The seed
   * itself doesn't need to bump activity because Room.handlePostMessage
   * already posted activity for that originating message.
   */
  private postActivity(): void {
    const roomId = this._roomId;
    if (!roomId) return;
    const threadId = this.name;
    const lastActivity = Date.now();
    this.ctx.waitUntil((async () => {
      try {
        const appStub = this.env.App.get(this.env.App.idFromName(APP_DO_NAME));
        await appStub.fetch(new Request("https://app/activity", {
          method:  "POST",
          headers: { "content-type": "application/json" },
          body:    JSON.stringify({ scope: "thread", scopeId: threadId, roomId, lastActivity }),
        }));
      } catch { /* swallow - best-effort */ }
    })());
  }

  /**
   * Enqueue @mention notifications to the App DO for the just-finished
   * assistant turn. Same shape as the Room path - the App owns dedup,
   * debounce, and webhook delivery.
   */
  private async maybeNotifyMentions(result: ChatResponseResult): Promise<void> {
    // Concatenate every text part of the assistant message - the model may
    // split its closing line across parts depending on tool-use shape.
    const text = (result.message.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map(p => p.text)
      .join("\n");
    const ids = extractMentionedUserIds(text);
    if (ids.length === 0) return;

    const roomId    = this._roomId ?? "";
    const threadId  = this.name;
    const messageId = (result.message as { id?: string }).id ?? "";
    const snippet   = buildSnippet(text);
    const roomName  = this._roomName ?? "thread";
    const createdAt = Date.now();

    const mentions = ids.map(userId => ({
      userId, roomId, threadId, messageId,
      snippet, authorName: "agent", roomName, createdAt,
    }));

    const appStub = this.env.App.get(this.env.App.idFromName(APP_DO_NAME));
    await appStub.fetch(new Request("https://app/notifications/enqueue", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ mentions }),
    }));
  }

  /**
   * Stamp buffered tool-call durations onto the persisted assistant
   * message and broadcast the update.
   *
   * Only fires the storage write + broadcast when something actually
   * changed - the common case for a model turn with no tool calls is a
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
    // Think's `updateMessageInHistory` doesn't broadcast - it only
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
   * the turn queue via saveMessages - safe here because Think releases
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
    // Wrap the whole dispatcher in one span; downstream workspace /
    // file calls re-nest underneath. `route` is the path with secrets
    // (e.g. preview-share tokens, future query-param API keys) stripped
    // by `redactSecrets` - we want grouping by route, not high-
    // cardinality URL strings, so query string is truncated by
    // taking just the pathname.
    const url = new URL(request.url);
    return trace("agent.onRequest", {
      "hackspace.thread_id": this.name,
      "hackspace.method": request.method,
      "hackspace.path": redactSecrets(url.pathname).slice(0, 256),
    }, async (span) => {
      const res = await this._onRequestImpl(request, url);
      span.set("hackspace.status", () => res.status);
      return res;
    });
  }

  /** Dispatcher body for `onRequest`. Extracted so the span wrapping in
   *  the public method stays small; the body is unchanged. */
  private async _onRequestImpl(request: Request, url: URL): Promise<Response> {

    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      return Response.json({
        count:    this.messages.length,
        messages: this.messages,
      }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname.endsWith("/vfs")) {
      const ws = await this._localWorkspace();
      // `pattern: undefined` means "return every entry under WORKSPACE".
      // Passing an empty string to `find()` compiles to `^$` (alpha.8
      // behaviour) and filters everything out.
      const matches = await ws.fs.find(WORKSPACE);
      const entries: Array<{ path: string; type: string; size: number; mtime: number }> = [];
      for (const m of matches) {
        try {
          const s = await ws.fs.stat(m.path);
          entries.push({
            path: m.path,
            type: s.isDirectory ? "dir" : "file",
            size: s.size ?? 0,
            mtime: s.mtime ?? 0,
          });
        } catch {
          // entry vanished between find and stat; skip
        }
      }
      return Response.json({ count: entries.length, entries }, { headers: { "cache-control": "no-store" } });
    }

    // GET /files-list?prefix=&limit= - prefix listing for the path
    // autocomplete in the file viewer. Narrower than /vfs (which
    // returns the full snapshot) so the popover can poll cheaply.
    if (request.method === "GET" && url.pathname.endsWith("/files-list")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (prefix.split("/").includes("..")) {
        return new Response("bad prefix", { status: 400 });
      }
      const limitRaw = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1), 100);
      const ws = await this._localWorkspace();
      // `pattern: undefined` returns the full tree; an empty string
      // would compile to `^$` and filter every entry out (alpha.8).
      const matches = await ws.fs.find(WORKSPACE);
      const all: ListingEntry[] = [];
      for (const m of matches) {
        try {
          const s = await ws.fs.stat(m.path);
          all.push({ path: m.path, type: s.isDirectory ? "dir" : "file" });
        } catch {
          // skip vanished entries
        }
      }
      const result = buildListing(all, prefix, limit);
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }

    // GET /files/<absolute path> - stream a workspace file with a
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
      const ws = await this._localWorkspace();
      let stat;
      try {
        stat = await ws.fs.stat(abs);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (!stat.isFile) {
        return new Response("not found", { status: 404 });
      }
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
      try {
        const stream = await ws.fs.readFile(abs);
        return new Response(stream, { headers });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (request.method === "GET" && url.pathname.endsWith("/tar")) {
      // Debug snapshot - dumps metadata, chat history, and the VFS
      // under /workspace as a single uncompressed ustar archive.
      // The workspace walk runs against the live `Workspace` on
      // this DO. We don't gate this on a successful ready(): if
      // the container is cold the tarball still ships with
      // metadata + messages, which is the bug-report bit anyway.
      let ws: Workspace | undefined;
      try {
        ws = await this._localWorkspace();
      } catch {
        ws = undefined;
      }
      const tar = await buildSessionTar({
        agentName: this.name,
        metadata:  {
          agent:        this.name,
          model:        currentModelId(this.env),
          messageCount: this.messages.length,
          capturedAt:   new Date().toISOString(),
        },
        messages:  this.messages,
        workspace: ws,
      });
      return new Response(tar as BodyInit, {
        headers: {
          "content-type":        "application/x-tar",
          "content-disposition": `attachment; filename="${this.name}.tar"`,
          "cache-control":       "no-store",
        },
      });
    }

    // ── Debug routes (forwarded from /debug/<sessionId>/<cmd>) ────────

    if (request.method === "POST" && url.pathname.endsWith("/exec")) {
      const { command, cwd, backend } = (await request.json().catch(() => ({}))) as {
        command?: string; cwd?: string; backend?: "shell" | "container";
      };
      if (!command) return Response.json({ error: "missing command" }, { status: 400 });
      const ws = await this._localWorkspace();
      const handle = await ws.shell.exec(command, { cwd, encoding: "utf8", backend });
      const result = await handle.result();
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname.endsWith("/env")) {
      const ws = await this._localWorkspace();
      const probe = async (command: string) => {
        try {
          const handle = await ws.shell.exec(command, { encoding: "utf8" });
          return await handle.result();
        } catch (err) {
          return { exitCode: -1, stdout: "", stderr: String(err) };
        }
      };
      const [node, npm, bun, esbuild, wrangler, uname, mounts, fuse] =
        await Promise.all([
          probe("node --version"),
          probe("npm --version"),
          probe("bun --version"),
          probe("esbuild --version"),
          probe("wrangler --version"),
          probe("uname -a"),
          probe("cat /proc/mounts | grep fuse || echo no-fuse"),
          probe("ls /dev/fuse 2>&1 || echo no-dev-fuse"),
        ]);
      return Response.json({ node, npm, bun, esbuild, wrangler, uname, mounts, fuse });
    }

    if (request.method === "GET" && url.pathname.endsWith("/logs")) {
      // wsd's stdio log lives under /tmp inside the container. The
      // workspace shell can `cat` it back for us; /tmp isn't part
      // of the synced workspace tree so a shell read is the right path.
      const ws = await this._localWorkspace();
      const handle = await ws.shell.exec("cat /tmp/server.log || true", { encoding: "utf8" });
      const result = await handle.result();
      return new Response(result.stdout || "(no log file yet)", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (request.method === "GET" && url.pathname.endsWith("/summary")) {
      return this.handleSummary();
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset")) {
      await this.clearMessages();
      // The agent's sessionId (which the pool keys assignments on) is this
      // DO's name. Releasing here returns the container to the pool
      // immediately on reset instead of waiting for the idle sweep -
      // matters most when a user resets a thread to recover from a
      // wedged exec (e.g. the 503 fallout we just spent three commits
      // hardening).
      await releaseContainer(this.env, this.name);
      return Response.json({ cleared: true });
    }

    // DELETE / - wipe everything (messages, VFS, summary, fork registry).
    // Called by the worker as part of /api/rooms/:id (cascade) and
    // /api/rooms/:id/threads/:tid deletion.
    if (request.method === "DELETE" && (url.pathname === "/" || url.pathname === "")) {
      await this.ctx.storage.deleteAll();
      await releaseContainer(this.env, this.name);
      return Response.json({ ok: true });
    }

    // POST /seed { roomId, threadId, message } - called by Room when an
    // @agent mention mints a thread. Persists the originating user message
    // so the agent sees it on first turn. Idempotent: re-seeding the same
    // message id is a no-op so the client can safely retry.
    if (request.method === "POST" && url.pathname.endsWith("/seed")) {
      const body = await request.json().catch(() => ({})) as {
        roomId?: unknown; roomName?: unknown; threadId?: unknown; message?: unknown;
      };
      const message = body.message;
      if (!message || typeof message !== "object") {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      const messageId = (message as { id?: unknown }).id;
      const alreadySeeded = typeof messageId === "string"
        && this.messages.some(m => m.id === messageId);
      if (!alreadySeeded) {
        // Cast through `any` - saveMessages accepts the AI SDK UIMessage shape;
        // we trust the caller (Room) to send a well-formed AppMessage.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.saveMessages([message as any]);
        // Seeding counts as a new message - arm the summary tick. The
        // assistant's reply will arm another one when its turn completes.
        this.ctx.waitUntil(this.kickSummary());
      }
      // Persist the roomId so getSystemPrompt() can build deep-link examples
      // pointing back to the originating room. Idempotent: overwriting with
      // the same value is fine, and Room always re-sends it on re-seed.
      if (typeof body.roomId === "string" && body.roomId) {
        this._roomId = body.roomId;
        await this.ctx.storage.put(Agent.ROOM_ID_STORAGE_KEY, body.roomId);
      }
      if (typeof body.roomName === "string" && body.roomName) {
        this._roomName = body.roomName;
        await this.ctx.storage.put(Agent.ROOM_NAME_STORAGE_KEY, body.roomName);
      }
      return Response.json({ ok: true, seeded: !alreadySeeded });
    }

    return new Response("not found", { status: 404 });
  }

  // ---- tools ----

  /**
   * Tools the agentic loop sees this turn. Single fixed tool set -
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

  /**
   * Introspection RPC for tests: drive the `schedule` tool's dispatch
   * directly (the tool's `execute` is closed over inside `buildTools`).
   * Exercises the real create/list/cancel path against durable storage.
   */
  async invokeScheduleTool(
    input: import("./schedule-tool.js").ScheduleToolInput,
  ): Promise<Record<string, unknown>> {
    return this._runScheduleTool(input);
  }

  /**
   * Introspection RPC for tests: drive the `cloudflare` tool's dispatch
   * directly (its `execute` is closed over inside `buildTools`).
   */
  async invokeCloudflareTool(
    command: "connect" | "status" | "disconnect",
    opts?: { toolCallId?: string; abortSignal?: AbortSignal },
  ): Promise<{ yields: Record<string, unknown>[]; result: Record<string, unknown> }> {
    const gen = this._runCloudflareTool(command, opts);
    const yields: Record<string, unknown>[] = [];
    let next = await gen.next();
    while (!next.done) {
      yields.push(next.value as Record<string, unknown>);
      next = await gen.next();
    }
    return { yields, result: next.value as Record<string, unknown> };
  }

  private buildTools() {
    // Resolve the WorkspaceStub once per turn; tools below close over
    // getWs and re-await it on each call. The cache lives in
    // this._workspaceStub so the underlying RPC handshake only runs
    // on first contact.
    const getWs = () => this._localWorkspace();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const pick = <T extends Record<string, unknown>>(name: string, def: T) =>
      ({ [name]: def });
    const editToolName = this.env.OPENAI_API_KEY ? "apply_patch" : "edit";

    return {
      ...pick("read",  createReadTool({ store: makeLazyStore(getWs) })),
      ...pick("write", createWriteTool({ store: makeLazyStore(getWs) })),
      ...(this.env.OPENAI_API_KEY
        ? pick("apply_patch", createApplyPatchTool({ store: makeLazyStore(getWs) }))
        : pick("edit", createEditTool({ store: makeLazyStore(getWs) }))),
      ...pick("webfetch", createWebFetchTool({ ai: this.env.AI })),
      ...(this.env.BRAVE_API_KEY
        ? pick("websearch", createWebSearchTool({
            provider: createBraveSearchProvider({ apiKey: this.env.BRAVE_API_KEY }),
          }))
        : {}),

      ...pick("ls", tool({
        description: "List files and directories at a path",
        inputSchema: z.object({ path: z.string().describe("Absolute directory path, e.g. /workspace") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          return { path, entries: await ws.fs.readdir(path) };
        },
      })),

      ...pick("stat", tool({
        description: "Get metadata for a file or directory: type, size, mtime",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          try {
            const s = await ws.fs.stat(path);
            return { path, type: s.isDirectory ? "dir" : "file", size: s.size, mtime: s.mtime, mode: s.mode };
          } catch {
            return { error: `Not found: ${path}` };
          }
        },
      })),

      ...pick("mkdir", tool({
        description: "Create a directory (including parent directories)",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          await ws.fs.mkdir(path, { recursive: true });
          return { path, created: true };
        },
      })),

      ...pick("rm", tool({
        description: "Delete a file or directory (recursive)",
        inputSchema: z.object({ path: z.string().describe("Absolute path to delete") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          await ws.fs.rm(path, { recursive: true, force: true });
          return { path, deleted: true };
        },
      })),

      ...pick("find", tool({
        description: "Search for files matching a pattern under a directory",
        inputSchema: z.object({
          directory: z.string().describe("Directory to search under, e.g. /workspace"),
          pattern:   z.string().optional().describe("Substring to match against filename, e.g. '.zig' or '.go'"),
        }),
        execute: async ({ directory, pattern }) => {
          const ws = await getWs();
          // Pass `pattern` through verbatim - the workspace's `find`
          // treats `undefined` as "no filter". Coercing to `""` here
          // would compile to `^$` and zero-out the result set.
          return { directory, pattern, matches: await ws.fs.find(directory, pattern) };
        },
      })),

      ...pick("grep", tool({
        description: "Search file contents for a string pattern. Returns matching lines.",
        inputSchema: z.object({
          pattern:    z.string().describe("String to search for"),
          path:       z.string().describe("File or directory to search"),
          ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
        }),
        execute: async ({ pattern, path, ignoreCase }) => {
          const ws = await getWs();
          return {
            pattern, path,
            matches: await ws.fs.grep(pattern, path, ignoreCase ? { ignoreCase } : {}),
          };
        },
      })),

      ...pick("exec", tool({
        description: [
          "Run a shell command in the workspace. The workspace exposes",
          "two backends with different capabilities; pick the cheapest",
          "one that can run the command.",
          "",
          "Backends:",
          '  - "shell" (default): just-bash in a Dynamic Worker. Cold-',
          "    start instant, no container, no public network. Good for",
          "    cat / grep / sed / awk / jq / head / tail / sort / find /",
          "    file inspection, quick text transformations, `git`",
          "    (clone / status / diff / log / branch / commit), and",
          "    `assets publish <path> [<expiry>]` to share a workspace",
          "    file as a time-limited public URL backed by R2.",
          "    `artifact create <name>` creates a Cloudflare Artifacts",
          "    git repo, mints a write token, and registers a git remote",
          "    in /workspace named <name>. `artifact share <name>`",
          "    mints a read token and prints one clone-ready URL for",
          "    sharing an existing repo. Both commands are wired into",
          "    the shell backend — no public network required. The",
          "    shell registers `git`, `assets`, and `artifact` as",
          "    built-in commands that forward to the host workspace, so",
          "    network-bound subcommands like `git clone`, `assets",
          "    publish`, and `artifact create/share` work even though",
          "    the isolate has no public network. Cannot run npm, node,",
          "    or any binary outside just-bash's built-in command set.",
          '  - "container": Cloudflare Container running wsd. Full Linux',
          "    userland with a Node 24 + Bun toolchain on $PATH (node, npm,",
          "    bun, esbuild, wrangler), public network. Cold start is much",
          "    slower (warm-pool boot); reach for it when shell can't",
          "    run the command \u2014 typically `bun install`, `bun test`,",
          "    `tsc`, `wrangler`, or anything else that needs a real",
          "    Linux binary. For git itself, prefer shell.",
          "",
          `Prefer the dedicated tools first: read / write / ${editToolName} / ls /`,
          "stat / mkdir / rm / find / grep for file ops. Use exec for",
          "git plumbing, builds, tests, typechecks, formatters.",
        ].join("\n"),
        inputSchema: z.object({
          command: z.string().describe(
            "Shell command, e.g. 'git clone https://github.com/owner/repo /workspace/repo' or 'bun test'."
          ),
          cwd: z.string().optional().describe("Working directory, defaults to /workspace."),
          backend: z.enum(["shell", "container"]).optional().describe(
            "Which backend to run on. Omit for the default ('shell'). " +
              "Set 'container' when the command needs bun / npm / node / a real " +
              "language toolchain. Keep 'shell' for git, text manipulation, " +
              "and anything the just-bash built-ins cover.",
          ),
        }),
        execute: this._execTool(),
      })),

      // git_clone retired in the workspace-next port: the shell
      // backend registers a built-in `git` command that forwards
      // every invocation across the loopback to the host's
      // workspace.git.cli (clone / status / diff / log / branch /
      // commit / ...). The model uses
      //   exec({ command: 'git clone https://...', backend: 'shell' })
      // which is described in the exec tool's per-backend guidance
      // and in the capabilities skill.

      // ── Sub-agent delegation ────────────────────────────────────
      //
      // `agentTool(SubAgent, options)` creates an AI SDK tool that:
      //   1. On call: picks or reuses a child SubAgent facet by a
      //      stable `runId`, calls `startAgentToolRun(input, { runId })`
      //      on it, waits for the turn to finish, and returns the result.
      //   2. Broadcasts `agent-tool-event` frames to connected clients
      //      so the UI can render live child progress.
      //   3. Handles chatRecovery on the child - a DO eviction mid-child
      //      turn is recovered transparently by the fiber infrastructure.
      //
      // The child DO name is derived from the `runId` the parent passes.
      // The child resolves `this.parentAgent(Agent)` → `getWorkspace()`
      // to obtain the shared workspace stub.
      //
      // `name` is the stable model-visible identifier for the child.
      // We encode it into `runId` so re-invoking the same name in a
      // later tool call re-uses the same child facet and its durable
      // history, enabling multi-turn conversations with a child.
      ...pick("delegate", agentTool(SubAgent, {
        description: [
          "Delegate a self-contained task to a named sub-agent that shares",
          "this workspace (/workspace). The sub-agent has the same file",
          `and exec tools as this agent (read/write/${editToolName}/ls/stat/mkdir/rm/`,
          "find/grep/exec/webfetch/websearch) but cannot delegate further.",
          "",
          "Good use-cases:",
          "  \u2022 Fan out parallel work: start several children with distinct",
          "    names writing to separate subdirectories.",
          "  \u2022 Off-load a slow build or research task while continuing to",
          "    answer the user.",
          "  \u2022 Give a child a tight scope (\"investigate only auth.ts\") so it",
          "    doesn't wander.",
          "",
          "The `name` field is the stable identifier for the child. Reusing",
          "the same name in a later call reconnects to that child's existing",
          "history, so you can have a multi-turn conversation with it.",
          "",
          "The tool returns when the child's turn is done (or on error).",
          "The result includes the child's summary and output.",
        ].join("\n"),
        inputSchema: z.object({
          name: z.string().min(1).max(64)
            .describe("Stable identifier for this child, e.g. 'researcher-auth' or 'builder-1'. Use the same name to continue a previous conversation."),
          task: z.string().min(1)
            .describe("Full task description. Be explicit - the sub-agent has no conversation context beyond what you send here."),
        }),
        displayName: "Sub-agent",
      })),

      ...pick("schedule", tool({
        description: [
          "Schedule future work for yourself: a one-off reminder or a",
          "recurring job. When a task fires you are woken with its prompt",
          "and run a normal turn, so write the prompt as an instruction to",
          "act on (e.g. 'Summarize new issues in the backlog').",
          "",
          "Sub-commands (set `command`):",
          "  - create: schedule a task. Provide `title`, `prompt`, and `when`.",
          "    `when` is one of:",
          "      - { type: 'delay', seconds }   one-off, N seconds from now",
          "      - { type: 'at', iso }           one-off at an absolute UTC time",
          "      - { type: 'cron', cron }        recurring, 5-field cron (UTC)",
          "  - list: show this thread's scheduled tasks (id, title, next run).",
          "  - cancel: remove a task by `id`.",
          "",
          "All times are UTC. Convert the user's wall-clock request to UTC",
          "yourself. Examples: 'remind me in 24h' -> create delay 86400;",
          "'every day at 8am UTC' -> create cron '0 8 * * *'.",
        ].join("\n"),
        inputSchema: scheduleToolSchema,
        execute: (input) => this._runScheduleTool(input),
      })),

      ...pick("cloudflare", tool({
        description: [
          "Access the Cloudflare API on behalf of the current user's own",
          "Cloudflare account, via the official Cloudflare MCP server. Once",
          "connected, you gain `search` and `execute` tools covering the",
          "entire Cloudflare API (DNS, Workers, R2, Zero Trust, and more).",
          "",
          "Auth is per-user and uses the account of whoever sent the most",
          "recent message. Sub-commands (set `command`):",
          "  - connect: start (or repair) authorization for the current user.",
          "    If they haven't authorized yet, this returns an `authUrl` - tell",
          "    the user to open it to grant access, then try again.",
          "  - status: report whether the current user is connected.",
          "  - disconnect: remove the current user's Cloudflare connection.",
          "",
          "When status/connect reports `authenticating` with an authUrl, surface",
          "that link to the user and wait; when `ready`, use the search/execute",
          "tools directly. If a previously-working connection returns to",
          "`authenticating`, the authorization expired - ask the user to",
          "re-authorize with the new link.",
        ].join("\n"),
        inputSchema: z.object({
          command: z.enum(["connect", "status", "disconnect"]).describe(
            "connect = authorize/refresh; status = check; disconnect = remove.",
          ),
        }),
        execute: (input) => this._runCloudflareTool(input.command),
      })),
    };
  }

  /**
   * Execute the `cloudflare` tool. Resolves the current user from the last
   * user message and dispatches connect/status/disconnect against their
   * per-user MCP connection.
   *
   * A streaming (async generator) tool: `connect` YIELDS an interim
   * `awaiting_auth` chunk carrying the OAuth authUrl - the frontend
   * CloudflareToolView renders that as a Continue/Cancel card - then polls
   * until the connection goes READY (the OAuth callback wrote the token to
   * KV), the user cancels (Cancel -> cancelToolCall -> abort signal), or a
   * deadline passes. `status`/`disconnect` yield a single terminal value.
   * Never throws for user-facing conditions.
   */
  private async *_runCloudflareTool(
    command: "connect" | "status" | "disconnect",
    opts?: { toolCallId?: string; abortSignal?: AbortSignal },
  ): AsyncGenerator<Record<string, unknown>, Record<string, unknown>, unknown> {
    if (!this.env.MCP_TOKENS) {
      return { error: "Cloudflare access is not configured on this deployment." };
    }
    const userId = lastUserAuthorId(this.messages as never);
    if (!userId) {
      return { error: "Cannot determine the requesting user for Cloudflare auth." };
    }

    if (command === "status") {
      return { ...this.cloudflareStatusFor(userId) };
    }

    if (command === "disconnect") {
      try {
        await this.removeMcpServer(normalizeServerId(cloudflareServerId(userId)));
        return { disconnected: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // command === "connect"
    const status = await this.ensureCloudflareConnection(userId);
    if (status.state === "ready") {
      return { phase: "ready" };
    }
    if (status.state === "failed") {
      return { phase: "failed", error: status.error };
    }

    // Authenticating (or connecting): surface the auth card, then poll. Register
    // an abort controller keyed by toolCallId so the Cancel button's
    // cancelToolCall RPC aborts the wait (mirrors the exec/raceWithSignal path).
    const authUrl =
      status.state === "authenticating" ? status.authUrl : null;
    yield {
      phase: "awaiting_auth",
      authUrl,
      title: "Authorize Cloudflare access",
      message:
        "Open the authorization link to grant access to your Cloudflare account.",
    };

    const controller = new AbortController();
    if (opts?.toolCallId) this._toolAborts.set(opts.toolCallId, controller);
    if (opts?.abortSignal) {
      if (opts.abortSignal.aborted) controller.abort(opts.abortSignal.reason);
      else
        opts.abortSignal.addEventListener("abort", () => controller.abort(opts.abortSignal?.reason), {
          once: true,
        });
    }

    try {
      const result = await pollCloudflareReady({
        getStatus: () => this.cloudflareStatusFor(userId),
        sleep: (ms, signal) => this._sleep(ms, signal),
        signal: controller.signal,
      });
      return { ...result, ...(authUrl && !("authUrl" in result) ? { authUrl } : {}) };
    } finally {
      if (opts?.toolCallId) this._toolAborts.delete(opts.toolCallId);
    }
  }

  /**
   * Sleep `ms`, resolving early (and cleanly) if `signal` aborts. Used by the
   * Cloudflare connect poll loop; the await opens the DO input gate so the
   * OAuth callback can run and flip the connection to READY between checks.
   */
  private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Execute the `schedule` tool. Dispatches on `command`; returns a
   * model-friendly object (never throws for user-correctable input - those
   * surface as `{ error }`). Framework/unexpected errors propagate to the
   * AI SDK's tool-error path.
   */
  private async _runScheduleTool(
    input: import("./schedule-tool.js").ScheduleToolInput,
  ): Promise<Record<string, unknown>> {
    try {
      if (input.command === "create") {
        if (!input.title || !input.prompt || !input.when) {
          return { error: "create requires title, prompt, and when" };
        }
        const { arg, kind } = resolveWhen(input.when);
        const payload: SchedulePayload = {
          title: input.title,
          prompt: input.prompt,
          kind,
        };
        // Cron is idempotent (dedup by callback+payload) so re-creating an
        // identical recurring task doesn't stack duplicate rows; one-offs are
        // intentionally not deduped.
        const schedule = await this.schedule(
          arg as Date | number | string,
          "runScheduledPrompt",
          payload,
          kind === "recurring" ? { idempotent: true } : undefined,
        );
        return {
          created: true,
          id: schedule.id,
          title: payload.title,
          kind,
          nextRun: new Date(schedule.time * 1000).toISOString(),
        };
      }

      if (input.command === "list") {
        const schedules = await this.listSchedules();
        return {
          tasks: describeSchedules(schedules as unknown as StoredScheduleView[]),
        };
      }

      // command === "cancel"
      if (!input.id) {
        return { error: "cancel requires the task id" };
      }
      const cancelled = await this.cancelSchedule(input.id);
      return { cancelled, id: input.id };
    } catch (err) {
      if (err instanceof ScheduleInputError) {
        return { error: err.message };
      }
      // Cron parse failures from the core scheduler are user-correctable too.
      const message = err instanceof Error ? err.message : String(err);
      if (/cron/i.test(message)) {
        return { error: `invalid schedule: ${message}` };
      }
      throw err;
    }
  }

  /**
   * Callback fired by the durable scheduler when a task comes due. NOT
   * `@callable` - invoked by the alarm, never by browser clients.
   *
   * Submits the stored prompt as a user-role turn via `submitMessages` -
   * Think's durable, FIFO, idempotent entry point - so the model runs a fresh
   * turn even if the DO was evicted between scheduling and firing. Existing
   * `onChatResponse` wiring surfaces the result to the room.
   *
   * Idempotency key includes the scheduled second so a recurring task submits
   * a distinct turn each firing, while an at-least-once double-fire of the
   * SAME occurrence collapses to one turn.
   */
  async runScheduledPrompt(
    payload: SchedulePayload,
    schedule?: { id?: string; time?: number },
  ): Promise<void> {
    if (!payload || typeof payload.prompt !== "string") return;
    const text = frameScheduledPrompt(payload);
    const occurrence = schedule?.time ?? Math.floor(Date.now() / 1000);
    const idempotencyKey = `sched:${schedule?.id ?? payload.title}:${occurrence}`;
    await this.submitMessages(
      [
        {
          id: shortId(),
          role: "user",
          parts: [{ type: "text", text }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      { idempotencyKey },
    );
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
  /**
   * Build the (non-streaming) exec tool execute function.
   *
   * The new @cloudflare/workspace exec surface returns a stream
   * client-side, but only the result() shape survives the Workers
   * RPC boundary between the Agent DO and the Sandbox DO. Until a
   * byte-framed streaming exec lands on WorkspaceShellStub, the
   * agent runs commands to completion and emits a single tool
   * result. This drops live-output streaming in the UI for long
   * builds; turn-level Stop still cancels via runCancellable.
   */
  private _execTool() {
    const self = this;
    return async (
      {
        command,
        cwd,
        backend,
      }: { command: string; cwd?: string; backend?: "shell" | "container" },
      opts: { toolCallId: string; abortSignal?: AbortSignal },
    ) => {
      // Resolve the backend the workspace will actually run against
      // *now*, before kicking off runCancellable, so error reports
      // name the right backend even when the model omitted it.
      const resolvedBackend = backend ?? (self.env.LOADER ? "shell" : "container");
      return self.runCancellable(
        opts,
        async () => {
          const ws = await self._localWorkspace();
          const handle = await ws.shell.exec(command, {
            cwd,
            encoding: "utf8",
            backend,
          });
          const result = await handle.result();
          return buildExecToolOutput({
            command,
            cwd,
            requestedBackend: backend,
            resolvedBackend,
          }, result);
        },
        {
          onError: (err) => buildExecToolError({
            command,
            cwd,
            requestedBackend: backend,
            resolvedBackend,
          }, err),
        },
      );
    };
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
   * The underlying workspace promise is *not* killed - the workspace SDK
   * doesn't accept abort signals - it's allowed to drain in the background.
   */
  @callable()
  async cancelToolCall(toolCallId: string): Promise<{ cancelled: boolean }> {
    return trace("agent.cancelToolCall", {
      "hackspace.thread_id": this.name,
      "hackspace.tool_call_id": toolCallId,
    }, async (span) => {
      const ctrl = this._toolAborts.get(toolCallId);
      span.set("hackspace.had_controller", () => ctrl !== undefined);
      if (!ctrl) return { cancelled: false };
      ctrl.abort(new Error("tool call cancelled by user"));
      return { cancelled: true };
    });
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

  /**
   * Spawn a SubAgent and return the tool names it exposes.
   * Used by tests to assert the child's tool set without driving a model turn.
   */
  async spawnAndInspectTools(childName: string): Promise<string[]> {
    const child = await this.subAgent(SubAgent, childName);
    return child.activeSubAgentToolNames();
  }

  /**
   * Spawn a SubAgent and return its system prompt.
   * Used by tests to assert the worker-agent preamble.
   */
  async spawnAndReadWorkerPrompt(childName: string): Promise<string> {
    const child = await this.subAgent(SubAgent, childName);
    return child.previewWorkerSystemPrompt();
  }

  /** Returns this agent's DO name. Used as a sanity RPC from children. */
  whoAmI(): string {
    return this.name;
  }

  /**
   * Append a bare user message to the conversation without driving a
   * model turn. Test-only helper - production code uses the chat WS or
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
  // exits - it does *not* reschedule itself. Old threads that nobody
  // touches simply stop ticking. The `/summary` endpoint is a pure read
  // of the cached value.

  /** Debounce window between a new message and the summary tick. */
  private static readonly SUMMARY_DEBOUNCE_SEC = 8;

  /** Cached summary blob persisted to storage so it survives eviction. */
  private static readonly SUMMARY_STORAGE_KEY = "thread-summary";

  /** Returns the cached summary. Pure read - never calls the model. */
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
   * advanced since the last run. Exits without rescheduling - the next
   * message will arm a fresh tick via `kickSummary()`. This is how
   * idle threads stop consuming model calls.
   */
  async runSummary(): Promise<void> {
    return trace("agent.runSummary", { "hackspace.thread_id": this.name }, async (span) => {
      const count = this.messages.length;
      span.set("hackspace.messages", () => count);
      if (count === 0) return;

      const cached = await this.ctx.storage.get<{ count: number; text: string }>(
        Agent.SUMMARY_STORAGE_KEY,
      );
      if (cached && cached.count === count) {
        span.set("hackspace.outcome", () => "cache-hit");
        return;
      }

      const transcript = renderTranscriptForSummary(this.messages);
      if (!transcript) {
        await this.ctx.storage.put(Agent.SUMMARY_STORAGE_KEY, { count, text: "" });
        span.set("hackspace.outcome", () => "empty-transcript");
        return;
      }
      span.set("hackspace.transcript_bytes", () => transcript.length);

      try {
        // Deliberately a cheap Workers AI model for the sidebar preview, not the
        // chat model. resolveModel() (think 0.12.0+) routes the `@cf/...` id
        // through the built-in provider off our AI binding, wiring
        // sessionAffinity for prefix-cache hits — no separate provider wiring.
        const kimi = this.resolveModel("@cf/moonshotai/kimi-k2.6");
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
        span.set("hackspace.summary_bytes", () => text.trim().length);
        span.set("hackspace.outcome", () => "generated");
      } catch (err) {
        // Swallow - the next message will trigger another attempt. We
        // intentionally don't overwrite the cached summary on failure so
        // a transient model error doesn't blank out a usable preview.
        // The span still records the error via setError so dashboards
        // can count failed summary runs without parsing logs.
        span.setError(err);
      }
    });
  }
}
/**
 * SubAgent - a worker Think DO spawned by the top-level `Agent` via
 * `agentTool(SubAgent, ...)` inside the parent's `getTools()` return.
 *
 * Each instance gets:
 *   - The parent's shared workspace (via `parentAgent(Agent).getWorkspace()`)
 *     so every file tool reads/writes the same VFS as the parent.
 *   - The same fs / exec tool set as the parent, minus `delegate`
 *     (workers do not spawn further workers).
 *   - A focused system prompt that tells it to complete its task and
 *     stop without asking back.
 *
 * Think's `agentTool()` factory (see `Agent.buildTools`) handles the
 * `startAgentToolRun` → stream → result pipeline automatically.
 * The child's chatRecovery fiber keeps the turn alive across DO
 * evictions, same as the parent.
 *
 * Naming convention: the parent passes `runId = name` from the
 * model's tool input; Think maps that to a child DO name so
 * subsequent calls with the same name reconnect to the same facet
 * and its durable message history (multi-turn children).
 */
export class SubAgent extends Think<Env> {
  override chatRecovery = true;

  // ── Workspace access ---------------------------------

  /**
   * Cache of the workspace stub fetched from the parent Agent DO.
   * The stub is an RpcTarget that wraps the parent's live Workspace,
   * so every fs/shell call crosses the DO-RPC boundary but operates
   * on the same underlying VFS.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _ws: any = null;

  /**
   * Fetch the parent's WorkspaceStub via Workers RPC.
   *
   * The parent DO exposes `getWorkspace()` as a public RPC so both
   * the worker backend's shell isolate and this sub-agent can reach
   * the same workspace without owning it. The RPC returns a
   * `Stub<WorkspaceStub>` (not a `WorkspaceStub` directly) because
   * Workers RPC wraps all `RpcTarget` return values in `Stub<T>`.
   * The stub surface (`fs`, `shell`) is identical at runtime.
   */
  private async _getWorkspace(): Promise<WorkspaceStub> {
    if (this._ws) return this._ws as WorkspaceStub;
    const parent = await this.parentAgent(Agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._ws = await (parent as any).getWorkspace();
    return this._ws as WorkspaceStub;
  }

  // ── Think overrides --------------------------------

  override getSystemPrompt(): string {
    return buildWorkerSystemPrompt({
      editToolName: this.env.OPENAI_API_KEY ? "apply_patch" : "edit",
    });
  }

  override getModel() {
    const modelId = currentModelId(this.env);
    if (this.env.OPENAI_API_KEY) {
      return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(modelId);
    }
    return createWorkersAI({ binding: this.env.AI })(modelId);
  }

  /**
   * Mirror the parent Agent's ZDR (Zero-Data-Retention) posture:
   * `store: false` + `include: reasoning.encrypted_content` so reasoning
   * is round-tripped inline rather than referenced by a server-side id.
   * Without this, OpenAI ZDR orgs reject the request with
   * "Items are not persisted for Zero Data Retention organizations."
   */
  override async beforeTurn() {
    return {
      maxSteps: 60,
      providerOptions: {
        openai: {
          reasoningEffort:
            (this.env as any).OPENAI_REASONING_EFFORT ?? "medium",
          reasoningSummary: "auto",
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      },
    };
  }

  override getTools() {
    // Close over _getWorkspace so every tool lazily resolves the stub.
    const getWs = () => this._getWorkspace();
    const pick = <T extends Record<string, unknown>>(name: string, def: T) =>
      ({ [name]: def });
    const editToolName = this.env.OPENAI_API_KEY ? "apply_patch" : "edit";

    return {
      ...pick("read",  createReadTool({ store: makeLazyStubStore(getWs) })),
      ...pick("write", createWriteTool({ store: makeLazyStubStore(getWs) })),
      ...(this.env.OPENAI_API_KEY
        ? pick("apply_patch", createApplyPatchTool({ store: makeLazyStubStore(getWs) }))
        : pick("edit", createEditTool({ store: makeLazyStubStore(getWs) }))),
      ...pick("webfetch", createWebFetchTool({ ai: this.env.AI })),
      ...(this.env.BRAVE_API_KEY
        ? pick("websearch", createWebSearchTool({
            provider: createBraveSearchProvider({ apiKey: this.env.BRAVE_API_KEY }),
          }))
        : {}),

      ...pick("ls", tool({
        description: "List files and directories at a path",
        inputSchema: z.object({ path: z.string().describe("Absolute directory path") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          return { path, entries: await ws.fs.readdir(path) };
        },
      })),

      ...pick("stat", tool({
        description: "Get metadata for a file or directory: type, size, mtime",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          try {
            const s = await ws.fs.stat(path);
            return { path, type: s.isDirectory ? "dir" : "file", size: s.size, mtime: s.mtime, mode: s.mode };
          } catch {
            return { error: `Not found: ${path}` };
          }
        },
      })),

      ...pick("mkdir", tool({
        description: "Create a directory (including parent directories)",
        inputSchema: z.object({ path: z.string().describe("Absolute path") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          await ws.fs.mkdir(path, { recursive: true });
          return { path, created: true };
        },
      })),

      ...pick("rm", tool({
        description: "Delete a file or directory (recursive)",
        inputSchema: z.object({ path: z.string().describe("Absolute path to delete") }),
        execute: async ({ path }) => {
          const ws = await getWs();
          await ws.fs.rm(path, { recursive: true, force: true });
          return { path, deleted: true };
        },
      })),

      ...pick("find", tool({
        description: "Search for files matching a pattern under a directory",
        inputSchema: z.object({
          directory: z.string().describe("Directory to search under"),
          pattern:   z.string().optional().describe("Substring to match against filename"),
        }),
        execute: async ({ directory, pattern }) => {
          const ws = await getWs();
          return { directory, pattern, matches: await ws.fs.find(directory, pattern) };
        },
      })),

      ...pick("grep", tool({
        description: "Search file contents for a string pattern. Returns matching lines.",
        inputSchema: z.object({
          pattern:    z.string().describe("String to search for"),
          path:       z.string().describe("File or directory to search"),
          ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
        }),
        execute: async ({ pattern, path, ignoreCase }) => {
          const ws = await getWs();
          return {
            pattern, path,
            matches: await ws.fs.grep(pattern, path, ignoreCase ? { ignoreCase } : {}),
          };
        },
      })),

      ...pick("exec", tool({
        description: [
          "Run a shell command in the workspace (shared with the parent agent).",
          "Backends:",
          '  - "shell" (default): just-bash in a Dynamic Worker. Instant boot.',
          "    Built-in commands: git, assets (publish), artifact (create/share).",
          '  - "container": full Linux userland with Node 24 + Bun. Use for bun/npm/node/tsc/wrangler.',
          `Prefer the dedicated tools first: read/write/${editToolName}/ls/stat/mkdir/rm/find/grep.`,
          "Key shell commands:",
          "  artifact create <name>  — create a git repo, mint a write token, register remote.",
          "  artifact share <name>   — mint a read token, print a clone-ready URL.",
          "  assets publish <path>   — share a workspace file as a public R2 URL.",
        ].join("\n"),
        inputSchema: z.object({
          command: z.string().describe("Shell command to run"),
          cwd:     z.string().optional().describe("Working directory, defaults to /workspace"),
          backend: z.enum(["shell", "container"]).optional().describe(
            "Backend to use. Omit for 'shell'. Set 'container' for bun/npm/node/tsc.",
          ),
        }),
        execute: async (
          { command, cwd, backend },
          opts: { toolCallId: string; abortSignal?: AbortSignal },
        ) => {
          const resolvedBackend = backend ?? (this.env.LOADER ? "shell" : "container");
          // Route exec through the parent's workspace shell so it runs
          // in the container attached to the parent's session.
          try {
            const ws = await getWs();
            const handle = await ws.shell.exec(command, { cwd, encoding: "utf8", backend });
            const result = await handle.result();
            return buildExecToolOutput({
              command,
              cwd,
              requestedBackend: backend,
              resolvedBackend,
            }, result);
          } catch (err) {
            return buildExecToolError({
              command,
              cwd,
              requestedBackend: backend,
              resolvedBackend,
            }, err);
          }
        },
      })),
    };
  }

  // ── Agent-tool output --------------------------------

  /**
   * Return the final text of the last assistant message as the
   * agent-tool output. The parent's `agentTool` call receives this
   * value in `RunAgentToolResult.output` / `.summary` once the child
   * turn completes.
   */
  protected override getAgentToolOutput(_runId: string): unknown {
    const msgs = [...this.messages].reverse();
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      const text = extractLastAssistantText(m);
      if (text) return text;
    }
    return null;
  }

  protected override getAgentToolSummary(_runId: string, output: unknown): string {
    if (typeof output === "string" && output.trim()) {
      // Trim to a short preview for parent event frames.
      return output.trim().slice(0, 500);
    }
    return "(no output)";
  }

  // ── Legacy sanity RPCs (preserved for existing tests) ----------

  /** Returns this sub-agent's DO name. Used as a sanity RPC. */
  whoAmI(): string {
    return this.name;
  }

  /** Returns the parent agent's DO name via `parentAgent(Agent)`. */
  async whoIsMyParent(): Promise<string> {
    const parent = await this.parentAgent(Agent);
    return parent.whoAmI();
  }

  // ── Introspection RPCs (used by tests) ──────────────────────────────

  /** Returns the tool names visible to the model on this sub-agent. */
  activeSubAgentToolNames(): string[] {
    return Object.keys(this.getTools());
  }

  /** Returns the worker system prompt (no AI binding required). */
  previewWorkerSystemPrompt(): string {
    return this.getSystemPrompt();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Race a tool's work against the turn's abort signal. The container/sandbox
 * APIs we call from `exec` don't all accept an `AbortSignal`, so when
 * the user clicks Stop we resolve the tool call
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
 * Strips reasoning/thinking parts and tool calls/results - the summary
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

// ── helpers for the buildTools rewrite ──────────────────────────

/**
 * Build a `FileStore` that lazily resolves the underlying
 * `WorkspaceFileStore` per call. Lets the fs-tools (`read` /
 * `write` / `edit`) close over a getter rather than a stub fixed at
 * tool-construction time - important because the agent's Workspace
 * stub is resolved asynchronously through the warm pool and the
 * cache can drop on a Sandbox cycle.
 */
function makeLazyStore(
  getWs: () => Promise<Workspace>,
): FileStore {
  // Build the inner store on first use, but rebuild if the
  // Workspace identity changes (a future workspace recycle or a
  // thread reset that swaps the instance).
  let cached: { ws: Workspace; store: FileStore } | null = null;
  const get = async (): Promise<FileStore> => {
    const ws = await getWs();
    if (!cached || cached.ws !== ws) {
      cached = { ws, store: new WorkspaceFileStore(adaptForFsTools(ws)) };
    }
    return cached.store;
  };
  return {
    async stat(path) {
      return (await get()).stat(path);
    },
    async readAll(path) {
      return (await get()).readAll(path);
    },
    async write(path, content, opts) {
      return (await get()).write(path, content, opts);
    },
    async delete(path) {
      const store = await get();
      if (!store.delete) throw new Error("delete is not supported by this file store");
      return store.delete(path);
    },
    async *readChunks(path, off, len) {
      const store = await get();
      for await (const chunk of store.readChunks(path, off, len)) {
        yield chunk;
      }
    },
  };
}

/**
 * Like `makeLazyStore` but for a `WorkspaceStub` (used by SubAgent
 * whose workspace comes from the parent via RPC rather than being
 * owned locally).
 *
 * The cache key is the stub reference itself. A new stub object from
 * a reconnect will rebuild the inner FileStore, same as the Workspace
 * variant does.
 */
function makeLazyStubStore(
  getStub: () => Promise<WorkspaceStub>,
): FileStore {
  let cached: { stub: WorkspaceStub; store: FileStore } | null = null;
  const get = async (): Promise<FileStore> => {
    const stub = await getStub();
    if (!cached || cached.stub !== stub) {
      cached = { stub, store: new WorkspaceFileStore(adaptForFsTools(stub)) };
    }
    return cached.store;
  };
  return {
    async stat(path) {
      return (await get()).stat(path);
    },
    async readAll(path) {
      return (await get()).readAll(path);
    },
    async write(path, content, opts) {
      return (await get()).write(path, content, opts);
    },
    async delete(path) {
      const store = await get();
      if (!store.delete) throw new Error("delete is not supported by this file store");
      return store.delete(path);
    },
    async *readChunks(path, off, len) {
      const store = await get();
      for await (const chunk of store.readChunks(path, off, len)) {
        yield chunk;
      }
    },
  };
}

/**
 * Extract the concatenated text parts from an assistant UIMessage.
 * Returns an empty string when the message contains no text parts.
 */
function extractLastAssistantText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m: any,
): string {
  if (!m || !Array.isArray(m.parts)) return "";
  return m.parts
    .filter((p: { type?: unknown }) => p && p.type === "text")
    .map((p: { text?: unknown }) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

