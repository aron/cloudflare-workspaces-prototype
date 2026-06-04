import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import {
  CloudflareContainerBackend,
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
} from "@cloudflare/workspace";
import { getServerByName, routePartykitRequest, Server } from "partyserver";
import type { RunEvent } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { handleApiRequest } from "./http";
import { createSandboxFixtureRuntime } from "./runtime/sandbox";
import { runSandboxFixtureSetup } from "./runtime/sandbox-run";
import { createWorkspaceFixtureRuntime } from "./runtime/workspace";
import { runWorkspaceFixtureSetup } from "./runtime/workspace-run";
import { startComparisonRun } from "./start-run";

export { Sandbox } from "@cloudflare/sandbox";
export { WorkspaceProxy };

export interface Env {
  CompareRun: DurableObjectNamespace<CompareRun>;
  Sandbox: DurableObjectNamespace<SandboxDO>;
}

interface DurableObjectStateWithExports extends DurableObjectState {
  exports: {
    WorkspaceProxy(options: { props: { binding: string; id: string } }): Fetcher;
  };
}

const EVENTS_KEY = "events";

export class CompareRun extends Server<Env> {
  static override options = { hibernate: true };

  readonly #workspace: Workspace;
  readonly #backend: CloudflareContainerBackend;
  #events: RunEvent[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const container = ctx.container;
    if (!container) {
      throw new Error("CompareRun DO is not container-enabled (check wrangler.jsonc)");
    }

    this.#backend = new CloudflareContainerBackend({
      container: () => container,
      egress: (ctx as DurableObjectStateWithExports).exports.WorkspaceProxy({
        props: { binding: "CompareRun", id: ctx.id.toString() },
      }),
    });
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });
  }

  override async onStart(): Promise<void> {
    this.#events = (await this.ctx.storage.get<RunEvent[]>(EVENTS_KEY)) ?? [];
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      return this.#backend.handleFetch(request);
    }

    return super.fetch(request);
  }

  override onConnect(connection: WebSocket): void {
    connection.send(JSON.stringify({ type: "history", events: this.#events }));
  }

  async startComparison(): Promise<RunEvent[]> {
    const runId = this.name;
    const timestamp = new Date().toISOString();
    const started: RunEvent = {
      id: `${runId}:started`,
      runId,
      sequence: 0,
      runtime: "both",
      kind: "run_started",
      title: "Comparison run started",
      detail: "Workspace and Sandbox agents are queued from the same fixture.",
      timestamp,
    };
    const sandbox = getSandbox(this.env.Sandbox, `${runId}-sandbox`);
    const [workspaceEvents, sandboxEvents] = await Promise.all([
      runWorkspaceFixtureSetup({
        runId,
        fixture: comparisonFixture,
        runtime: createWorkspaceFixtureRuntime(this.#workspace),
        now: () => new Date().toISOString(),
      }),
      runSandboxFixtureSetup({
        runId,
        fixture: comparisonFixture,
        runtime: createSandboxFixtureRuntime(sandbox),
        now: () => new Date().toISOString(),
      }),
    ]);

    this.#events = [started, ...workspaceEvents, ...sandboxEvents].sort(
      (left, right) => left.sequence - right.sequence,
    );
    await this.ctx.storage.put(EVENTS_KEY, this.#events);
    this.broadcast(JSON.stringify({ type: "history", events: this.#events }));

    return this.#events;
  }
}

export default {
  async fetch(request, env) {
    const apiResponse = await handleApiRequest(request, () =>
      startComparisonRun({
        getRun: (runId) => getServerByName(env.CompareRun, runId),
      }),
    );

    if (apiResponse) {
      return apiResponse;
    }

    return (await routePartykitRequest(request, env)) ?? new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
