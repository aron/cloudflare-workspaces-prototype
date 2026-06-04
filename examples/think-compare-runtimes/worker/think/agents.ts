import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import {
  CloudflareContainerBackend,
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
} from "@cloudflare/workspace";
import type { ToolSet } from "ai";
import { getServerByName } from "partyserver";
import { createWorkersAI } from "workers-ai-provider";
import type { ComparisonFixture } from "../../shared/fixture";
import type { CompareRun } from "../index";
import {
  createSandboxRuntimeAdapter,
  createWorkspaceRuntimeAdapter,
  type RuntimeAdapter,
} from "../runtime/adapter";
import {
  createSandboxCommandRunner,
  createSandboxFileStore,
  createSandboxFixtureRuntime,
} from "../runtime/sandbox";
import { seedFixture } from "../runtime/seed";
import {
  createWorkspaceCommandRunner,
  createWorkspaceFileStore,
  createWorkspaceFixtureRuntime,
} from "../runtime/workspace";
import { runRealThinkTurn } from "./real-turn";
import { type CompareRunEventSink, createRemoteRunEventRecorder } from "./remote-recorder";
import { createRuntimeThinkTools, type RuntimeThinkToolRecorder } from "./runtime-tools";

export { WorkspaceProxy };

const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

export interface RuntimeThinkAgentEnv {
  AI: Ai;
  CompareRun: DurableObjectNamespace<CompareRun>;
  Sandbox: DurableObjectNamespace<SandboxDO>;
}

interface DurableObjectStateWithExports extends DurableObjectState {
  exports: {
    WorkspaceProxy(options: { props: { binding: string; id: string } }): Fetcher;
  };
}

interface RunConfig {
  runId: string;
  fixture: ComparisonFixture;
}

abstract class RuntimeThinkAgent extends Think<RuntimeThinkAgentEnv> {
  #preparedTools: ToolSet | null = null;

  override chatRecovery = false;

  abstract readonly runtimeLabel: "Workspace" | "Sandbox";

  protected abstract createAdapter(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<RuntimeAdapter>;

  protected abstract seedRuntime(config: RunConfig): Promise<void>;

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID);
  }

  override getSystemPrompt(): string {
    return [
      "You are one side of a strict Think-vs-Think runtime comparison.",
      `You are running against the ${this.runtimeLabel} runtime.`,
      "Use the available read, write, edit, and exec tools to complete the task.",
      "Prefer read/write/edit for file operations. Use exec for runtime verification when useful.",
      "When finished, summarize what you changed and what runtime behavior you observed.",
    ].join("\n");
  }

  async runComparison(config: RunConfig): Promise<void> {
    const compareRun = (await getServerByName(
      this.env.CompareRun,
      config.runId,
    )) as unknown as CompareRunEventSink;
    const recorder = createRemoteRunEventRecorder(compareRun);
    await this.seedRuntime(config);
    const adapter = await this.createAdapter(config, recorder);
    this.#preparedTools = createRuntimeThinkTools({ adapter, recorder }) as unknown as ToolSet;

    await runRealThinkTurn({
      adapter,
      recorder,
      fixture: config.fixture,
      invoke: ({ prompt }) => this.invokeThink(prompt),
    });
  }

  override getTools(): ToolSet {
    return this.#preparedTools ?? ({} as ToolSet);
  }

  async invokeThink(prompt: string): Promise<{ text: string }> {
    const submission = await this.submitMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ]);

    return { text: await this.awaitAssistantText(submission.submissionId) };
  }

  async awaitAssistantText(submissionId: string): Promise<string> {
    for (;;) {
      const inspection = await this.inspectSubmission(submissionId);
      if (!inspection) throw new Error(`Submission ${submissionId} vanished`);
      if (inspection.status === "completed") {
        return (
          collectAssistantText(this.messages) || "Think turn completed without assistant text."
        );
      }
      if (
        inspection.status === "error" ||
        inspection.status === "aborted" ||
        inspection.status === "skipped"
      ) {
        throw new Error(
          `Think turn ended in status=${inspection.status}${inspection.error ? `: ${inspection.error}` : ""}`,
        );
      }
      await scheduler.wait(500);
    }
  }
}

export class WorkspaceThinkAgent extends RuntimeThinkAgent {
  readonly runtimeLabel = "Workspace";
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: RuntimeThinkAgentEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) {
      throw new Error("WorkspaceThinkAgent DO is not container-enabled (check wrangler.jsonc)");
    }
    this.#backend = new CloudflareContainerBackend({
      container: () => container,
      egress: (ctx as DurableObjectStateWithExports).exports.WorkspaceProxy({
        props: { binding: "WorkspaceThinkAgent", id: ctx.id.toString() },
      }),
    });
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.#backend.handleFetch(request);
    }
    return super.fetch(request);
  }

  protected async seedRuntime(config: RunConfig): Promise<void> {
    await seedFixture(createWorkspaceFixtureRuntime(this.#workspace), config.fixture);
  }

  protected async createAdapter(_config: RunConfig, recorder: RuntimeThinkToolRecorder) {
    return createWorkspaceRuntimeAdapter({
      recorder,
      store: createWorkspaceFileStore(this.#workspace),
      runner: createWorkspaceCommandRunner(this.#workspace),
    });
  }
}

export class SandboxThinkAgent extends RuntimeThinkAgent {
  readonly runtimeLabel = "Sandbox";

  protected async seedRuntime(config: RunConfig): Promise<void> {
    const sandbox = this.getSandbox(config);
    await seedFixture(createSandboxFixtureRuntime(sandbox), config.fixture);
  }

  protected async createAdapter(config: RunConfig, recorder: RuntimeThinkToolRecorder) {
    const sandbox = this.getSandbox(config);
    return createSandboxRuntimeAdapter({
      recorder,
      store: createSandboxFileStore(sandbox),
      runner: createSandboxCommandRunner(sandbox),
    });
  }

  private getSandbox(config: RunConfig) {
    return getSandbox(this.env.Sandbox, `${config.runId}-sandbox-think`);
  }
}

function collectAssistantText(messages: Array<{ role?: string; parts?: Array<unknown> }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parts = message.parts ?? [];
    const text = parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidate = part as { type?: string; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string"
          ? candidate.text
          : "";
      })
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}
