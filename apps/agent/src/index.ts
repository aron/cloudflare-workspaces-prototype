import { routeAgentRequest } from "agents";
import { Agent, SubAgent } from "./agent.js";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { PERSONAS, DEFAULT_PERSONA } from "./personas/index.js";
import { WarmPool } from "./warm-pool.js";
import { resolveContainerId, poolStats, primePool } from "./pool.js";
import { verifyAccessJwt } from "./access.js";

export { Agent, SubAgent, Sandbox, WarmPool };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Cloudflare Access gate. Set ACCESS_TEAM_DOMAIN + ACCESS_AUD in
    // wrangler.jsonc vars (or as secrets) to enable. Skip when not
    // configured so local `wrangler dev` still works.
    if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
      try {
        await verifyAccessJwt(request, {
          teamDomain: env.ACCESS_TEAM_DOMAIN,
          aud:        env.ACCESS_AUD,
        });
      } catch (err) {
        return new Response(`Access denied: ${(err as Error).message}`, { status: 401 });
      }
    }

    const url = new URL(request.url);

    // Top-level persona registry — used by the chat UI to populate the
    // "New session" dropdown. Stateless, no session required.
    if (request.method === "GET" && url.pathname === "/personas") {
      return Response.json({
        // Don't ship systemPrompt to the browser — it's huge and the UI only
        // needs id/name/description/extraTools.
        personas: PERSONAS.map(({ systemPrompt: _, ...rest }) => rest),
        default:  DEFAULT_PERSONA.id,
      }, { headers: { "cache-control": "public, max-age=60" } });
    }

    // /debug/<sessionId>/exec|env|logs
    if (url.pathname.startsWith("/debug/")) {
      const parts = url.pathname.slice("/debug/".length).split("/");
      const sessionId = parts[0];
      const cmd       = parts[1];
      if (!sessionId) return new Response("missing session id", { status: 400 });

      // Resolve the caller-provided session id through the warm pool so we
      // hit the same container the agent uses.
      const containerId = await resolveContainerId(env, sessionId);
      const sb = getSandbox(env.Sandbox, containerId);

      if (cmd === "exec" && request.method === "POST") {
        const { command, cwd } = await request.json() as { command: string; cwd?: string };
        const result = await sb.exec(command, { cwd });
        return Response.json(result);
      }

      if (cmd === "env") {
        const [zig, go, node, esbuild, wrangler, uname, mounts, fuse] = await Promise.all([
          sb.exec("zig version"),
          sb.exec("go version"),
          sb.exec("node --version"),
          sb.exec("esbuild --version"),
          sb.exec("wrangler --version"),
          sb.exec("uname -a"),
          sb.exec("cat /proc/mounts | grep fuse || echo no-fuse"),
          sb.exec("ls /dev/fuse 2>&1 || echo no-dev-fuse"),
        ]);
        return Response.json({ zig, go, node, esbuild, wrangler, uname, mounts, fuse });
      }

      if (cmd === "logs") {
        const file = await sb.readFile("/tmp/server.log");
        return new Response(file?.content ?? "(no log file yet)", { headers: { "content-type": "text/plain" } });
      }

      // Forward agent-level debug routes (messages, vfs, reset) to the DO's onRequest().
      if (cmd === "messages" || cmd === "vfs" || cmd === "reset" || cmd === "persona") {
        const id   = env.Agent.idFromName(sessionId);
        const stub = env.Agent.get(id);
        return stub.fetch(request);
      }

      if (cmd === "pool") {
        return Response.json(await poolStats(env));
      }

      return new Response("not found", { status: 404 });
    }

    // Agent WebSocket connections and RPC calls
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("not found", { status: 404 });
  },

  /**
   * Cron-triggered: prime the warm pool so its alarm loop is running.
   * Wrangler config wires this up to `* * * * *` (every minute).
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await primePool(env);
  },
} satisfies ExportedHandler<Env>;
