/**
 * Test worker for the agent.
 *
 * Re-exports the production `Agent` and `SubAgent` DO classes verbatim, with
 * a bare `routeAgentRequest` Worker around them. The production Worker's
 * Access JWT gate, persona registry endpoint, debug routes, warm pool, and
 * `Sandbox` DO binding are intentionally absent — tests address agents by
 * name directly and never invoke container-backed tools.
 */

import { routeAgentRequest } from "agents";

export { Agent, SubAgent } from "../agent.js";
export { MountHost } from "./mount-host.js";

import type { Agent, SubAgent } from "../agent.js";
import type { MountHost } from "./mount-host.js";

export type Env = {
  Agent: DurableObjectNamespace<Agent>;
  SubAgent: DurableObjectNamespace<SubAgent>;
  MountHost: DurableObjectNamespace<MountHost>;
  LOADER: WorkerLoader;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
