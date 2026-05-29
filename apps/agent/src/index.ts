import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { Agent, SubAgent } from "./agent.js";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { WarmPool } from "./warm-pool.js";
import { resolveContainerId, poolStats, primePool } from "./pool.js";
import { App, APP_DO_NAME } from "./app.js";
import { Room } from "./room.js";
import {
  resolveIdentity,
  withIdentity,
  type AccessIdentity,
} from "./identity.js";
import { resolveBaseUrl, withBaseUrl } from "./base-url.js";

export { Agent, SubAgent, App, Room, Sandbox, WarmPool };

type Variables = { identity: AccessIdentity; baseUrl: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- middleware ----------------------------------------------------------
//
// Resolve Access identity once per request. Access is required in prod;
// local dev falls back to ACCESS_DEV_USER (or a hardcoded local identity).
app.use("*", async (c, next) => {
  const identity = await resolveIdentity(c.req.raw, c.env);
  if (!identity) {
    return c.text("Access denied", 401);
  }
  c.set("identity", identity);
  // Resolve once per request: env var wins, otherwise the origin of the
  // inbound request. Stored on context so DO forwarders don't recompute.
  c.set("baseUrl", resolveBaseUrl(c.env, c.req.raw));
  await next();
});

// ---- /api/app/* ----------------------------------------------------------
//
// Proxy to the singleton App DO. When a room is created we also seed the
// corresponding Room DO so the client can talk to it immediately.
app.all("/api/app/*", async (c) => {
  const identity = c.get("identity");
  const baseUrl  = c.get("baseUrl");
  const request = c.req.raw;
  const url = new URL(request.url);

  // Block external access to the DO-internal notify-lookup endpoint.
  if (url.pathname === "/api/app/notify-lookup") {
    return c.text("not found", 404);
  }
  const innerUrl = new URL(request.url);
  innerUrl.pathname = url.pathname.slice("/api/app".length) || "/";
  const inner = new Request(innerUrl, request);
  const stub = c.env.App.get(c.env.App.idFromName(APP_DO_NAME));
  const res = await stub.fetch(withIdentity(inner, identity, baseUrl));

  // Side-effect: when App creates a room, init the Room so /api/rooms/:id
  // is immediately usable. We don't fail the response if init fails — the
  // room row exists, the client can retry.
  if (
    res.status === 201 &&
    url.pathname.endsWith("/rooms") &&
    request.method === "POST"
  ) {
    const cloned = res.clone();
    const body = (await cloned.json().catch(() => null)) as {
      room?: { id: string; name: string; createdBy: string };
    } | null;
    if (body?.room) {
      const roomStub = c.env.Room.get(c.env.Room.idFromName(body.room.id));
      await roomStub
        .fetch(
          withIdentity(
            new Request("https://room/init", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body.room),
            }),
            identity,
            baseUrl,
          ),
        )
        .catch(() => undefined);
    }
  }
  return res;
});

// ---- /api/rooms/:id/* ----------------------------------------------------
//
// Forward to a per-room DO. WebSocket upgrades pass through transparently.
// We compute the inner path from the URL directly because Hono doesn't expose
// the wildcard capture as a named parameter.
// DELETE /api/rooms/:id — wipe the Room DO (returns thread ids it owned),
// cascade-wipe each per-thread Agent DO, and remove the App registry row.
// Done as a dedicated route so we can orchestrate the multi-DO cleanup; the
// catch-all forwarder below still handles GET/POST/etc on the same paths.
app.delete("/api/rooms/:id", async (c) => {
  const id = c.req.param("id");
  const identity = c.get("identity");
  const baseUrl  = c.get("baseUrl");
  const roomStub = c.env.Room.get(c.env.Room.idFromName(id));
  const roomRes = await roomStub.fetch(
    withIdentity(new Request("https://room/", { method: "DELETE" }), identity, baseUrl),
  );
  // Best-effort cascade: even if Room reported failure, try to clean up the
  // pieces we know about so a half-deleted room doesn't linger in the UI.
  const body = (await roomRes
    .clone()
    .json()
    .catch(() => ({}))) as { threadIds?: unknown };
  const threadIds = Array.isArray(body.threadIds)
    ? body.threadIds.filter((x): x is string => typeof x === "string")
    : [];
  await Promise.allSettled(
    threadIds.map((tid) => {
      const stub = c.env.Agent.get(c.env.Agent.idFromName(tid));
      return stub.fetch(
        withIdentity(
          new Request("https://agent/", { method: "DELETE" }),
          identity,
          baseUrl,
        ),
      );
    }),
  );
  const appStub = c.env.App.get(c.env.App.idFromName(APP_DO_NAME));
  await appStub
    .fetch(
      withIdentity(
        new Request(`https://app/rooms/${id}`, { method: "DELETE" }),
        identity,
        baseUrl,
      ),
    )
    .catch(() => undefined);
  return roomRes;
});

// DELETE /api/rooms/:id/threads/:tid — detach the thread from the room and
// wipe the backing Agent DO. The originating message stays in the room.
app.delete("/api/rooms/:id/threads/:tid", async (c) => {
  const id = c.req.param("id");
  const tid = c.req.param("tid");
  const identity = c.get("identity");
  const baseUrl  = c.get("baseUrl");
  const roomStub = c.env.Room.get(c.env.Room.idFromName(id));
  const roomRes = await roomStub.fetch(
    withIdentity(
      new Request(`https://room/threads/${tid}`, { method: "DELETE" }),
      identity,
      baseUrl,
    ),
  );
  const agentStub = c.env.Agent.get(c.env.Agent.idFromName(tid));
  await agentStub
    .fetch(
      withIdentity(
        new Request("https://agent/", { method: "DELETE" }),
        identity,
        baseUrl,
      ),
    )
    .catch(() => undefined);
  return roomRes;
});

app.all("/api/rooms/:id/*", (c) => {
  const id = c.req.param("id");
  const inner = stripPrefix(c.req.raw.url, `/api/rooms/${id}`);
  return forwardToDO(c.env.Room, id, c.req.raw, c.get("identity"), c.get("baseUrl"), inner);
});
app.all("/api/rooms/:id", (c) => {
  const id = c.req.param("id");
  return forwardToDO(c.env.Room, id, c.req.raw, c.get("identity"), c.get("baseUrl"), "/");
});

// ---- /api/threads/:threadId/* -------------------------------------------
//
// Forward to the Agent DO that owns a thread (threadId == Agent DO name).
// Hono's `app.all` doesn't include HEAD in its method list. The file
// viewer's HEAD-then-GET probe relies on HEAD reaching the DO, so we
// register it explicitly here (same forwarder either way).
app.on("HEAD", "/api/threads/:id/*", (c) => {
  const id = c.req.param("id");
  const inner = stripPrefix(c.req.raw.url, `/api/threads/${id}`);
  return forwardToDO(c.env.Agent, id, c.req.raw, c.get("identity"), c.get("baseUrl"), inner);
});

app.all("/api/threads/:id/*", (c) => {
  const id = c.req.param("id");
  const inner = stripPrefix(c.req.raw.url, `/api/threads/${id}`);
  return forwardToDO(c.env.Agent, id, c.req.raw, c.get("identity"), c.get("baseUrl"), inner);
});
app.all("/api/threads/:id", (c) => {
  const id = c.req.param("id");
  return forwardToDO(c.env.Agent, id, c.req.raw, c.get("identity"), c.get("baseUrl"), "/");
});

// ---- /debug/:sessionId/:cmd ---------------------------------------------
//
// Debug routes hit the same warm-pool container the agent uses, plus a
// passthrough to the Agent DO for messages/vfs/reset.
app.post("/debug/:sessionId/exec", async (c) => {
  const sb = getSandbox(
    c.env.Sandbox,
    await resolveContainerId(c.env, c.req.param("sessionId")),
    { enableDefaultSession: false },
  );
  const { command, cwd } = (await c.req.json()) as {
    command: string;
    cwd?: string;
  };
  return Response.json(await sb.exec(command, { cwd }));
});

app.get("/debug/:sessionId/env", async (c) => {
  const sb = getSandbox(
    c.env.Sandbox,
    await resolveContainerId(c.env, c.req.param("sessionId")),
    { enableDefaultSession: false },
  );
  const [zig, go, node, esbuild, wrangler, uname, mounts, fuse] =
    await Promise.all([
      sb.exec("zig version"),
      sb.exec("go version"),
      sb.exec("node --version"),
      sb.exec("esbuild --version"),
      sb.exec("wrangler --version"),
      sb.exec("uname -a"),
      sb.exec("cat /proc/mounts | grep fuse || echo no-fuse"),
      sb.exec("ls /dev/fuse 2>&1 || echo no-dev-fuse"),
    ]);
  return Response.json({
    zig,
    go,
    node,
    esbuild,
    wrangler,
    uname,
    mounts,
    fuse,
  });
});

app.get("/debug/:sessionId/logs", async (c) => {
  const sb = getSandbox(
    c.env.Sandbox,
    await resolveContainerId(c.env, c.req.param("sessionId")),
    { enableDefaultSession: false },
  );
  const file = await sb.readFile("/tmp/server.log");
  return new Response(file?.content ?? "(no log file yet)", {
    headers: { "content-type": "text/plain" },
  });
});

app.get("/debug/:sessionId/pool", async (c) =>
  Response.json(await poolStats(c.env)),
);

// Forward agent-level debug routes (messages, vfs, reset) to the DO's onRequest().
app.all("/debug/:sessionId/:cmd{messages|vfs|reset}", (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.Agent.idFromName(sessionId);
  const stub = c.env.Agent.get(id);
  return stub.fetch(withIdentity(c.req.raw, c.get("identity"), c.get("baseUrl")));
});

// ---- Agent WebSocket / RPC fallthrough -----------------------------------
//
// Anything we didn't match is offered to the agents SDK router. It owns the
// WebSocket upgrade path and RPC calls. Attach worker-trusted identity so
// the Agent DO can stamp user messages even when the connection is shared.
app.all("*", async (c) => {
  const res = await routeAgentRequest(
    withIdentity(c.req.raw, c.get("identity"), c.get("baseUrl")),
    c.env,
  );
  return res ?? c.text("not found", 404);
});

// ---- helpers -------------------------------------------------------------

/**
 * Strip our /api/<prefix>/:id from the URL and forward the remainder to the
 * named Durable Object stub with identity attached.
 */
function forwardToDO<T extends Rpc.DurableObjectBranded | undefined>(
  ns: DurableObjectNamespace<T>,
  id: string | undefined,
  request: Request,
  identity: AccessIdentity,
  baseUrl: string,
  innerPath: string,
): Promise<Response> {
  if (!id) {
    return Promise.resolve(new Response("missing id", { status: 400 }));
  }
  const inner = new URL(request.url);
  inner.pathname = innerPath;
  const stub = ns.get(ns.idFromName(id));
  return stub.fetch(withIdentity(new Request(inner, request), identity, baseUrl));
}

/** Return the URL pathname with `prefix` removed, guaranteed to start with `/`. */
function stripPrefix(url: string, prefix: string): string {
  const path = new URL(url).pathname;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

// ---- export --------------------------------------------------------------

export default {
  fetch: app.fetch,

  /**
   * Cron-triggered: prime the warm pool so its alarm loop is running.
   * Wrangler config wires this up to `* * * * *` (every minute).
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await primePool(env);
  },
} satisfies ExportedHandler<Env>;
