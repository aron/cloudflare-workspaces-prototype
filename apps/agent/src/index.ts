import { routeAgentRequest } from "agents";
import { Agent } from "./agent.js";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { PERSONAS, DEFAULT_PERSONA } from "./personas/index.js";
import { WarmPool } from "./warm-pool.js";
import { resolveContainerId, poolStats, primePool } from "./pool.js";
import { AppDO, APP_DO_NAME } from "./app-do.js";
import { RoomDO } from "./room-do.js";
import { resolveIdentity, withIdentity, type AccessIdentity } from "./identity.js";

export { Agent, AppDO, RoomDO, Sandbox, WarmPool };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Resolve identity for every request. Access is required in prod; local
    // dev falls back to ACCESS_DEV_USER (or a hardcoded local identity).
    const identity = await resolveIdentity(request, env);
    if (!identity) {
      return new Response("Access denied", { status: 401 });
    }

    const url = new URL(request.url);

    // /api/app/* — proxied to the singleton AppDO with identity attached.
    if (url.pathname.startsWith("/api/app/")) {
      return handleAppRequest(request, env, identity);
    }

    // /api/rooms/:id/...  — proxied to the per-room DO.
    if (url.pathname.startsWith("/api/rooms/")) {
      return handleRoomRequest(request, env, identity);
    }



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
        return stub.fetch(withIdentity(request, identity));
      }

      if (cmd === "pool") {
        return Response.json(await poolStats(env));
      }

      return new Response("not found", { status: 404 });
    }

    // Agent WebSocket connections and RPC calls
    // Attach worker-trusted identity headers so the Agent DO can stamp
    // user messages with the correct author metadata even when the connection
    // is shared by multiple humans (the WS frame itself carries no identity).
    const agentResponse = await routeAgentRequest(withIdentity(request, identity), env);
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

// ---- helpers ----

/**
 * Forward to the singleton AppDO. When a room is created we also seed the
 * corresponding RoomDO so the client can talk to it immediately.
 */
async function handleAppRequest(
  request:  Request,
  env:      Env,
  identity: AccessIdentity,
): Promise<Response> {
  const url      = new URL(request.url);
  const innerUrl = new URL(request.url);
  innerUrl.pathname = url.pathname.slice("/api/app".length) || "/";
  const inner = new Request(innerUrl, request);
  const stub  = env.AppDO.get(env.AppDO.idFromName(APP_DO_NAME));
  const res   = await stub.fetch(withIdentity(inner, identity));

  // Side-effect: when AppDO creates a room, init the RoomDO so /api/rooms/:id
  // is immediately usable. We don't fail the response if init fails — the
  // room row exists, the client can retry.
  if (res.status === 201 && url.pathname.endsWith("/rooms") && request.method === "POST") {
    const cloned = res.clone();
    const body   = await cloned.json().catch(() => null) as { room?: { id: string; name: string; createdBy: string } } | null;
    if (body?.room) {
      const roomStub = env.RoomDO.get(env.RoomDO.idFromName(body.room.id));
      await roomStub.fetch(withIdentity(
        new Request("https://room/init", {
          method:  "POST",
          headers: { "content-type": "application/json" },
          body:    JSON.stringify(body.room),
        }),
        identity,
      )).catch(() => undefined);
    }
  }
  return res;
}

/**
 * Forward to a per-room DO. URL shape: `/api/rooms/:id/<path>` → `/<path>`.
 * WebSocket upgrades are passed through transparently.
 */
function handleRoomRequest(
  request:  Request,
  env:      Env,
  identity: AccessIdentity,
): Promise<Response> {
  const url   = new URL(request.url);
  const parts = url.pathname.slice("/api/rooms/".length).split("/");
  const id    = parts[0];
  if (!id) {
    return Promise.resolve(new Response("missing room id", { status: 400 }));
  }
  const inner = new URL(request.url);
  inner.pathname = "/" + parts.slice(1).join("/");
  const stub = env.RoomDO.get(env.RoomDO.idFromName(id));
  return stub.fetch(withIdentity(new Request(inner, request), identity));
}
