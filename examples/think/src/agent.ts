/**
 * TriageAgent — a Think Durable Object that owns one triage turn.
 *
 * Wiring:
 *   - super(state, env) hands us Agent + Think machinery (message
 *     store, agentic loop, workflow integration).
 *   - We additionally own a `@cloudflare/workspace.Workspace` backed
 *     by a Cloudflare Container running `wsd`. Mirrors the pattern
 *     in examples/wsd-container.
 *   - Think's own `workspace` field expects a string-based
 *     `WorkspaceLike` for its built-in workspace tools. We satisfy
 *     it with a small adapter over the container workspace and turn
 *     off `workspaceBash` because we expose our own `exec` tool.
 *     We also shadow Think's `read`/`write`/`edit` tool names with
 *     our vendored fs-tools (their streaming/byte-cap behaviour is
 *     friendlier for this example).
 *
 * Phase model:
 *   - The workflow flips `phase` via `setPhase("explore" | "structure")`
 *     before each `step.do` / `step.prompt`. "explore" exposes the
 *     full toolset (read/write/edit/exec/git_clone/ls/report_update);
 *     "structure" hides every tool so the AI-SDK structured-output
 *     path doesn't fight the agentic loop. The phase is persisted to
 *     durable storage so a recovered turn keeps the right tools.
 */

import type { StepContext, WorkspaceLike as ThinkWorkspaceLike } from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import {
  CloudflareContainerBackend,
  type DurableObjectStorageLike,
  localContainerHost,
  Workspace,
  WorkspaceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { type ToolSet, tool } from "ai";
import { createPatch } from "diff";
import git from "isomorphic-git";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { createExecTool } from "./tools/exec.js";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type WorkspaceLike as FsWorkspaceLike,
  WorkspaceFileStore,
} from "./tools/fs/index.js";
import { createGitCloneTool } from "./tools/git/clone.js";
import { createWorkspaceVfs } from "./tools/git/vfs.js";
import { createReportUpdateTool } from "./tools/report-update.js";

// Re-export so the runtime can build a loopback binding for the
// container egress (ctx.exports.WorkspaceProxy below). Same trick
// the wsd-container example uses.
export { WorkspaceProxy };

/**
 * Per-turn phase. The workflow flips this before each model step:
 *
 *   - "explore":   full toolset (read + write + edit + exec + git_clone
 *                 + ls + report_update). The agent decides whether to
 *                 attempt a fix or just gather findings, depending on
 *                 how big the change looks.
 *   - "structure": no tools at all — used by the workflow's tool-less
 *                 `step.prompt` that coerces the explore turn's text
 *                 into the final zod schema. The structured-output
 *                 AI-SDK path is incompatible with tool calls on
 *                 Workers AI, so we hide them.
 */
export type TriagePhase = "explore" | "structure";

/**
 * Outcome of `runAgentTurn`. Folded out of `inspectSubmission` so the
 * workflow can decide whether to keep going or bail out gracefully.
 *
 *   - `ok`            normal completion with a non-empty assistant text.
 *   - `out-of-steps`  Think stopped on `stepCountIs(maxSteps)` mid-loop;
 *                     no final text was emitted.
 *   - `failed`        underlying submission ended in error/aborted/
 *                     skipped — typically a context-window overflow
 *                     on Workers AI. `reason` carries the detail.
 */
export interface AgentTurnResult {
  status: "ok" | "out-of-steps" | "failed";
  text: string;
  /** Empty string on `ok`; populated for `out-of-steps` / `failed`. */
  reason: string;
}

export interface TriageContext {
  issueUrl: string;
  webhookUrl: string;
  /**
   * When true, every assistant text part, tool call, and tool result
   * is POSTed to the webhook as a `{ type: "debug" }` event. Off by
   * default; the workflow only flips it when the caller asked for
   * it via the original /issue payload.
   */
  debug: boolean;
}

const CONTEXT_KEY = "triage-context";
const PHASE_KEY = "triage-phase";

const REPO_ROOT = "/workspace/repo";
const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

export class TriageAgent extends Think<Env> {
  /**
   * Off. The workflow is the durable layer here — `step.do` and
   * `step.prompt` replay deterministically through any DO eviction,
   * and `submitMessages` is keyed by an idempotent submissionId so a
   * replayed `runAgentTurn` reuses the prior turn's row rather than
   * starting over. Leaving Think's per-turn chat recovery on top of
   * that just spams `_chatRecoveryContinue timed out waiting for
   * stable state` when an upstream call (a Workers AI 502, a Kimi
   * context overflow) wedges a turn in a non-terminal state — the
   * recovery loop has nothing useful to do, there is no human
   * watching transient chat state, and the workflow's own retry is
   * the right replay boundary for this design.
   */
  override chatRecovery = false;

  /** Plenty of budget for a triage + fix + verify loop. */
  override maxSteps = 40;

  /** We have a dedicated `exec` tool; skip Think's bash. */
  override workspaceBash = false;

  /**
   * Container-backed Workspace. Separate from Think's `workspace`
   * field (which it uses for its built-in tools) — see below.
   */
  readonly #backend: CloudflareContainerBackend;
  readonly #containerWs: Workspace;
  /**
   * Shared isomorphic-git cache. Reused across every isogit call this
   * agent makes (clone, walk, resolveRef, …). Without this, each call
   * re-parses the packfile from scratch — a ~20 MB read through the
   * SQLite-backed VFS — which is what makes a naive `gitDiff` take
   * many minutes on a real repo.
   */
  readonly #gitCache: Record<string, unknown> = {};

  /** Cached context written by the Worker before the workflow runs. */
  #context: TriageContext | null = null;

  /** Current phase. `null` outside a workflow run. */
  #phase: TriagePhase | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#backend = new CloudflareContainerBackend({
      container: () => localContainerHost(ctx),
      workspace: ctx.exports.WorkspaceProxy({
        props: { binding: "TriageAgent", id: ctx.id.toString() },
      }),
    });
    this.#containerWs = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });

    // Hand Think an adapter that satisfies its WorkspaceLike, so the
    // baseline read/write/edit tools have something to delegate to —
    // even though we shadow most of those names below.
    this.workspace = adaptToThinkWorkspace(this.#containerWs) as unknown as ThinkWorkspaceLike;

    this.ctx.blockConcurrencyWhile(async () => {
      this.#context = (await this.ctx.storage.get<TriageContext>(CONTEXT_KEY)) ?? null;
      this.#phase = (await this.ctx.storage.get<TriagePhase>(PHASE_KEY)) ?? null;
    });
  }

  // ── DO container surface ───────────────────────────────────────

  /** Forwarded by the Worker fetch handler for /ws upgrades. */
  override async fetch(request: Request): Promise<Response> {
    // Container upgrade path: pass directly to the backend. Anything
    // else falls through to the framework (Think + Agent inherit
    // their own request routing from agents-sdk).
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.#backend.handleFetch(request);
    }
    return super.fetch(request);
  }

  /** Hand out a typed RPC stub to the workspace if a caller wants one. */
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#containerWs.ready();
    return this.#containerWs.stub();
  }

  // ── Workflow control surface ──────────────────────────────────

  /** Called by the Worker once, right before kicking off the workflow. */
  async setContext(context: TriageContext): Promise<void> {
    this.#context = context;
    await this.ctx.storage.put(CONTEXT_KEY, context);
  }

  async getContext(): Promise<TriageContext | null> {
    return this.#context;
  }

  /** Called by the workflow inside a step.do before each step.prompt. */
  async setPhase(phase: TriagePhase): Promise<void> {
    this.#phase = phase;
    await this.ctx.storage.put(PHASE_KEY, phase);
  }

  /**
   * Worker → agent entry point. Schedules the workflow and tracks it
   * in the agent's runtime DB (provided by `Agent.runWorkflow`).
   */
  async startTriage(params: { issueUrl: string }): Promise<string> {
    if (!this.#context) {
      throw new Error("setContext() must be called before startTriage()");
    }
    await this.#containerWs.ready();
    return this.runWorkflow("TRIAGE_WORKFLOW", params);
  }

  /** Used by `notify-done` to POST the terminal payload. */
  async postWebhook(payload: {
    message: string;
    patch?: string;
    commit?: { subject: string; body: string };
  }): Promise<void> {
    const ctx = this.#context;
    if (!ctx) throw new Error("No triage context bound");
    await fetch(ctx.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Compute a unified diff between HEAD and the working tree, the same
   * way `git diff HEAD` would, but in pure JS via isomorphic-git +
   * the `diff` package. Empty string means the agent didn't change
   * anything; we also return empty (rather than throwing) if HEAD
   * can't be resolved (e.g. the agent never cloned).
   *
   * We use isomorphic-git here for consistency with `git_clone` and
   * to keep the example portable: any environment that can run a
   * Worker can run this, regardless of whether `shell.exec` has the
   * right binaries available.
   */
  async gitDiff(): Promise<string> {
    await this.#containerWs.ready();
    const dir = REPO_ROOT;
    const vfs = createWorkspaceVfs(this.#containerWs.provider());
    let head: string;
    try {
      head = await git.resolveRef({ fs: vfs, dir, ref: "HEAD" });
    } catch {
      return "";
    }
    // Single tree walk — compare HEAD tree to the working tree in
    // one pass. The earlier shape was `statusMatrix` + a per-file
    // `readBlob`, which is O(files × packfile-parse) because
    // isomorphic-git's readBlob defaults to `cache: {}` per call:
    // every lookup re-parses the entire pack from the SQLite-backed
    // VFS. On a 950-entry / ~20 MB-pack repo that hangs for many
    // minutes. `git.walk` reuses one cache across the whole
    // traversal, and we pass our own #gitCache so subsequent calls
    // (and the clone) don't re-pay the parse either.
    const chunks: string[] = [];
    try {
      await git.walk({
        fs: vfs,
        dir,
        cache: this.#gitCache,
        trees: [git.TREE({ ref: head }), git.WORKDIR()],
        map: async (filepath, [headEntry, workEntry]) => {
          if (filepath === "." || filepath.startsWith(".git")) return;
          const headType = headEntry ? await headEntry.type() : null;
          const workType = workEntry ? await workEntry.type() : null;
          // Only diff blobs. Pure directories on either side carry
          // no bytes to compare.
          const isHeadFile = headType === "blob";
          const isWorkFile = workType === "blob";
          if (!isHeadFile && !isWorkFile) return;
          const headText =
            isHeadFile && headEntry
              ? bufferToText((await headEntry.content()) as Uint8Array | undefined)
              : "";
          const workText =
            isWorkFile && workEntry
              ? bufferToText((await workEntry.content()) as Uint8Array | undefined)
              : "";
          if (headText === workText) return;
          const patch = createPatch(filepath, headText, workText, "", "");
          if (patch.trim().length > 0) chunks.push(patch);
        },
      });
    } catch {
      // Walk can fail if HEAD points at an object we don't have
      // (a partial / interrupted clone). Treat as "no diff".
      return "";
    }
    return chunks.join("\n");
  }

  /**
   * Run one full Think turn with the model and the current phase's
   * tools available. Returns the assistant text the model produced
   * once the turn reaches a terminal state.
   *
   * This is the "exploration" half of the two-step pattern from
   * `docs/think/workflows.md`: do the work with tools here, then have
   * the workflow follow up with a tool-less `step.prompt` that just
   * coerces this turn's text into structured output. The two steps
   * run as separate Workflow steps so a crash between them replays
   * deterministically.
   *
   * Uses `submitMessages` (the same primitive `step.prompt` uses
   * under the hood) so the turn is durable and idempotent, then polls
   * `inspectSubmission` until terminal. We don't pass the workflow
   * metadata that `step.prompt` would attach — we want the result
   * back in-band, not via a Workflow event.
   */
  async runAgentTurn(prompt: string): Promise<AgentTurnResult> {
    const submission = await this.submitMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ]);
    return this.#awaitAssistantText(submission.submissionId);
  }

  /**
   * Spin until the submission reaches a terminal status, then walk
   * `this.messages` back for the most recent assistant text.
   *
   * Three terminal shapes get folded into `AgentTurnResult` instead
   * of being thrown:
   *
   *   - `completed` + non-empty text  -> `{ status: "ok", text }`
   *   - `completed` + empty text       -> `{ status: "out-of-steps", text: "" }`
   *     (Think stopped on `stepCountIs(maxSteps)` mid-thought.)
   *   - `error` / `aborted` / `skipped` -> `{ status: "failed", text, reason }`
   *     (typical cause is Workers AI giving up on a context-window
   *     overflow; the SSE stream fails to parse, the submission is
   *     marked errored, and we capture whatever assistant text was
   *     produced before the cutoff.)
   *
   * The workflow checks `status` and short-circuits to `notify-done`
   * when the budget is exhausted, rather than wedging on a half-empty
   * structuring step.
   */
  async #awaitAssistantText(submissionId: string): Promise<AgentTurnResult> {
    const POLL_MS = 500;
    const MAX_MS = 30 * 60 * 1000; // 30 min hard ceiling.
    const start = Date.now();
    while (Date.now() - start < MAX_MS) {
      const insp = await this.inspectSubmission(submissionId);
      if (!insp) throw new Error(`Submission ${submissionId} vanished`);
      if (insp.status === "completed") {
        const text = collectAssistantText(this.messages);
        if (text.length > 0) return { status: "ok", text, reason: "" };
        return {
          status: "out-of-steps",
          text: "",
          reason:
            "Agent completed without emitting a final assistant text — likely hit the maxSteps budget mid-loop.",
        };
      }
      if (insp.status === "error" || insp.status === "aborted" || insp.status === "skipped") {
        return {
          status: "failed",
          text: collectAssistantText(this.messages),
          reason:
            `Agent turn ended in status=${insp.status}` + (insp.error ? `: ${insp.error}` : ""),
        };
      }
      await sleep(POLL_MS);
    }
    return {
      status: "failed",
      text: collectAssistantText(this.messages),
      reason: `Agent turn timed out after ${MAX_MS}ms`,
    };
  }

  // ── Think hooks ───────────────────────────────────────────────

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID);
  }

  /**
   * Kimi K2.6 has a 262,144-token context window but the Workers AI
   * runtime caps generations at a small default (a few thousand
   * tokens) when `max_tokens` is unset — enough to truncate mid-
   * tool-call. Bump it to something that lets the model finish a
   * structured answer or a chain of tool calls.
   *
   * 16k is well under the 262k window and leaves plenty of room for
   * input — the workflow's prior tool calls + the system prompt
   * commonly run ~30–50k tokens by the time we hit the structure
   * phase, so the input dominates anyway.
   */
  override async beforeTurn() {
    return { maxOutputTokens: 16384 };
  }

  override getSystemPrompt(): string {
    const phase = this.#phase ?? "explore";
    if (phase === "structure") {
      return [
        "You are a JSON-shaping assistant. The user message contains a",
        "prior analysis the agent produced. Reply with structured",
        "output that matches the schema you were given. Do not invent",
        "new findings; only restructure what the prior turn already",
        "said. No tools are available in this phase.",
      ].join("\n");
    }
    return [
      "You are a triage assistant for a GitHub issue.",
      "",
      `Repository will be cloned into ${REPO_ROOT}.`,
      "",
      "Tools available, in preference order. Reach for `exec` last —",
      "the dedicated tools are faster, give structured output, and",
      "don't depend on which binaries happen to live in the",
      "container:",
      "  - git_clone:     shallow-clone the repository.",
      "  - read, ls:      explore the working tree. Prefer these over",
      "                   `exec cat` / `exec ls`.",
      "  - write, edit:   modify files. Prefer these over `exec sed`",
      "                   / `exec tee` / shell heredocs.",
      "  - exec:          run shell commands. Reserve this for things",
      "                   the other tools can't do — typically the",
      "                   project's own tests / typecheck / build",
      "                   commands (npm test, vitest run, cargo test,",
      "                   go test, etc.). Do NOT use it for file I/O",
      "                   that `read` / `ls` / `write` / `edit` cover.",
      "  - report_update: progress updates back to the user.",
      "",
      "Workflow:",
      "  1. Clone the repo. Read what you need to understand the bug.",
      "  2. Decide: is this a small, well-scoped change you can confidently",
      "     make in a handful of edits, with a way to verify it?",
      "       - YES  -> apply the minimal fix with `write` / `edit`, run the",
      "                project's own tests / typecheck via `exec` to confirm,",
      "                then describe the commit you made.",
      "       - NO   -> do not edit anything. Write up the findings: what",
      "                the bug is, the files most likely involved, and the",
      "                concrete next steps a human should take.",
      "  3. Use `report_update` a few times to keep the user posted. Keep",
      "     messages terse — one or two sentences. Do NOT say 'DONE'",
      "     yourself; the workflow emits the terminal message.",
      "",
      "When you are happy with the outcome, reply with a short natural-",
      "language summary covering:",
      "  - whether you attempted a fix (yes/no) and why",
      "  - a one-line imperative commit subject (even for findings-only,",
      "    treat it as 'investigate: …' or 'docs: …' so the workflow can",
      "    use it as the headline)",
      "  - one or two paragraphs of context (commit body / findings)",
      "  - the absolute paths of any files you edited (may be empty)",
      "  - the verification commands you ran, in order (may be empty)",
      "  - concrete next steps a human should take (may be empty if the",
      "    fix is complete)",
      "",
      "The workflow will compute the unified diff itself via `git diff",
      "HEAD`; you do not need to include it.",
    ].join("\n");
  }

  override getTools(): ToolSet {
    const ctx = this.#context;
    if (!ctx) return {} as ToolSet;

    const phase = this.#phase ?? "explore";
    if (phase === "structure") return {} as ToolSet;

    const store = new WorkspaceFileStore(adaptToFsWorkspace(this.#containerWs));
    const containerWs = this.#containerWs;
    return {
      git_clone: createGitCloneTool({
        provider: containerWs.provider(),
        cache: this.#gitCache,
      }),
      // Per-tool caps. Kimi K2.6 has a 262k context window so we
      // don't need to be paranoid; the caps are mostly so a
      // pathological tool call (giant lockfile, multi-MB log) doesn't
      // burn through the input budget on a single turn. ~32 KiB ≈
      // ~8k tokens per read.
      read: createReadTool({ store, maxBytes: 32 * 1024, maxLines: 800 }),
      ls: createLsTool(containerWs),
      write: createWriteTool({ store }),
      edit: createEditTool({ store }),
      exec: createExecTool({ workspace: containerWs, maxBytes: 32 * 1024 }),
      report_update: createReportUpdateTool({ webhookUrl: ctx.webhookUrl }),
    };
  }

  // ── Debug hooks ────────────────────────────────────────────────
  //
  // When `context.debug` is set, every tool call and every step's
  // assistant text gets POSTed to the webhook as a `type:"debug"`
  // event so the caller can watch the agent think. The terminal
  // notify-done payload is unchanged.
  //
  // Hooks used:
  //   afterToolCall  — fires once per tool execution.
  //   onStepFinish   — fires once per model round (a "step" in
  //                    AI-SDK terms). This is the right hook for
  //                    intermediate assistant text: between tool
  //                    calls the model often produces reasoning
  //                    or partial text, and onChatResponse only
  //                    fires at the very end of the whole
  //                    submission, so it skips everything in
  //                    between.

  override async afterToolCall(ctx: {
    toolName: string;
    toolCallId: string;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    if (!this.#context?.debug) return;
    this.#postDebug({
      kind: "tool-call",
      tool: ctx.toolName,
      toolCallId: ctx.toolCallId,
      durationMs: ctx.durationMs,
      success: ctx.success,
      ...(ctx.success ? { output: redact(ctx.output) } : { error: String(ctx.error) }),
    });
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    if (!this.#context?.debug) return;
    const text = typeof ctx.text === "string" ? ctx.text.trim() : "";
    const reasoning = extractReasoning(ctx);
    const toolCalls = Array.isArray(ctx.toolCalls)
      ? ctx.toolCalls.map((c) => c.toolName).filter((n): n is string => typeof n === "string")
      : [];
    // Skip empty steps — pure-control steps with no text, no
    // reasoning, and no tool calls don't help the watcher.
    if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) return;
    this.#postDebug({
      kind: "step",
      text,
      reasoning,
      toolCalls,
      finishReason: typeof ctx.finishReason === "string" ? ctx.finishReason : undefined,
    });
  }

  override async onChatResponse(_result: unknown): Promise<void> {
    if (!this.#context?.debug) return;
    // Submission boundary marker. Per-step content is emitted by
    // onStepFinish above; this just lets the CLI know the agent's
    // current submission has reached a terminal state.
    this.#postDebug({ kind: "submission-complete" });
  }

  #postDebug(payload: Record<string, unknown>): void {
    const ctx = this.#context;
    if (!ctx) return;
    // Fire-and-forget through waitUntil so a slow or unreachable
    // webhook doesn't stall the agent loop. afterToolCall and
    // onStepFinish are both awaited by Think before the next step
    // runs; inlining the POST would pin every step on the webhook's
    // RTT. The trade is no backpressure — fine for a debug stream,
    // not fine for the terminal notify-done payload (which still
    // awaits via postWebhook above).
    const body = JSON.stringify({ type: "debug", phase: this.#phase ?? "", ...payload });
    this.ctx.waitUntil(
      fetch(ctx.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
        .then((res) => {
          // Drain the body so the connection can be reused; the
          // CLI returns 204 with no payload, but other receivers
          // might.
          void res.body?.cancel();
        })
        .catch(() => {
          // Debug delivery is best-effort — don't crash a turn
          // over it. The error already happened off the critical
          // path; nothing useful to log inside the DO.
        }),
    );
  }
}

// ── Adapters ───────────────────────────────────────────────────────

/**
 * Bridge from `@cloudflare/workspace.Workspace` to the vendored
 * fs-tools' `WorkspaceLike` shape. The vendored tools only call into
 * `fs.{stat,readFile,writeFile,mkdir}`, which the container
 * workspace already exposes directly.
 */
function adaptToFsWorkspace(ws: Workspace): FsWorkspaceLike {
  return ws as unknown as FsWorkspaceLike;
}

/**
 * Bridge from `@cloudflare/workspace.Workspace` to Think's
 * string-shaped `WorkspaceLike`. Think only constructs the default
 * workspace tools lazily; nothing calls these methods unless the
 * model actually invokes a default tool, and our `getTools()`
 * shadows the names we care about. The adapters exist so the Think
 * baseline doesn't crash if it does fire.
 */
function adaptToThinkWorkspace(ws: Workspace) {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await ws.fs.readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readFileBytes(path: string): Promise<Uint8Array | null> {
      try {
        const stream = await ws.fs.readFile(path);
        return await drain(stream);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path: string, content: string): Promise<void> {
      await ws.fs.writeFile(path, new TextEncoder().encode(content));
    },
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      await ws.fs.mkdir(path, opts?.recursive ? { recursive: true } : {});
    },
    async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await ws.fs.rm(path, {
        ...(opts?.recursive ? { recursive: true as const } : {}),
        ...(opts?.force ? { force: true as const } : {}),
      });
    },
    async stat(path: string) {
      try {
        const s = await ws.fs.stat(path);
        return {
          path,
          name: path.split("/").pop() ?? path,
          type: s.isDirectory ? ("directory" as const) : ("file" as const),
          size: s.size,
          modifiedAt: new Date(s.mtime),
          isDirectory: s.isDirectory,
          isFile: s.isFile,
        };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readDir(dir: string) {
      const entries = await ws.fs.readdir(dir);
      return entries.map((e) => ({
        path: `${dir}/${e.name}`,
        name: e.name,
        type: e.isDirectory ? ("directory" as const) : ("file" as const),
        size: 0,
        modifiedAt: new Date(0),
        isDirectory: e.isDirectory,
        isFile: e.isFile,
      }));
    },
    async glob(pattern: string) {
      // Cheap shim — full glob semantics aren't needed in this demo.
      // Think's built-in grep filters by `entry.type === "file"`, so
      // we have to stat each candidate to know whether it's a blob.
      // ws.fs.find already returns the type alongside the path, so
      // forward it directly instead of re-stat'ing. Without this,
      // every grep returned filesSearched: 0.
      const matches = await ws.fs.find("/workspace", pattern);
      return matches.map((m) => ({
        path: m.path,
        name: m.path.split("/").pop() ?? m.path,
        type: m.type === "dir" ? ("directory" as const) : ("file" as const),
        size: 0,
        modifiedAt: new Date(0),
        isDirectory: m.type === "dir",
        isFile: m.type === "file",
      }));
    },
  };
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ── A small `ls` tool: vendored fs-tools don't include it. ─────────

function createLsTool(ws: Workspace) {
  return tool({
    description:
      "List the immediate children of a workspace directory. Returns " +
      "names with their type (file/dir). One level only.",
    inputSchema: z.object({
      path: z.string().describe("Absolute directory path."),
    }),
    execute: async ({ path }) => {
      const entries = await ws.fs.readdir(path);
      return {
        path,
        entries: entries.map((e) => ({
          name: e.name,
          type: e.isDirectory ? "dir" : "file",
        })),
      };
    },
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * Walk a UIMessage[] back to front, find the most recent assistant
 * message, and join its visible text parts. Reasoning parts and tool
 * parts are dropped — the structuring step / debug stream only care
 * about the model's natural-language response.
 */
/**
 * Pull a flat reasoning string out of a StepContext. Providers vary:
 * some expose `reasoning` as a single string, some as an array of
 * `{ type: "reasoning", text }` parts, some put the same content on
 * `reasoningText`. We coalesce all three shapes into one string and
 * leave the consumer to decide whether to print it.
 */
function extractReasoning(ctx: unknown): string {
  const record = ctx as { reasoning?: unknown; reasoningText?: unknown };
  const raw = record.reasoning ?? record.reasoningText ?? "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((r) => {
        if (typeof r === "string") return r;
        if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
          return (r as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function collectAssistantText(
  messages: ReadonlyArray<{ role: string; parts: Array<{ type: string; text?: string }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate huge tool outputs so a chatty `exec` doesn't blow the
 * webhook receiver up. We don't try to be clever about structure;
 * the debug stream is a development aid, not a transcript.
 */
function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 4000
      ? `${value.slice(0, 4000)}… [truncated, ${value.length - 4000} more chars]`
      : value;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      if (s.length <= 4000) return value;
      return `[object too large for debug: ${s.length} chars]`;
    } catch {
      return "[unserialisable]";
    }
  }
  return value;
}

/**
 * Best-effort UTF-8 decode for a WalkerEntry.content() buffer. The
 * isomorphic-git walker hands back a Uint8Array for blobs and null
 * for non-blob entries (the caller filters those out before calling
 * us). Binary content is decoded with replacement chars rather than
 * thrown — a noisy diff still ships a patch the user can read.
 */
function bufferToText(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(buf);
}
