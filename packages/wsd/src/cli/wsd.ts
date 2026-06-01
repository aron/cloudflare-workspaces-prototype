#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { createWorkspaceClient, type WorkspaceClient } from "@cloudflare/workspace-rpc/client";
import {
  acceptWebSocketSession,
  createWorkspaceServer,
  serveHTTPBatch,
} from "@cloudflare/workspace-rpc/server";
import { WebSocket, WebSocketServer } from "ws";
import { Runner } from "../exec/index.js";
import {
  createNodeVirtualFileSystem,
  detectFUSEBackend,
  type FUSEBackend,
  type FuseMount,
  mountFuse,
} from "../fuse/index.js";

const DEFAULT_PORT = 45678;
const DEFAULT_MOUNT_POINT = "/workspace";
const HOST = "0.0.0.0";

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(value)}`);
  }

  return port;
}

function parseMountPoint(value: string | undefined): string {
  const mountPoint = value === undefined || value === "" ? DEFAULT_MOUNT_POINT : value;
  if (!isAbsolute(mountPoint)) {
    throw new Error(`MOUNT_POINT must be an absolute path, got ${JSON.stringify(value)}`);
  }

  return mountPoint;
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname;
}

interface WSDInfo {
  backend: FUSEBackend;
  mountPoint: string;
  port: number;
}

interface HTTPHandle {
  server: Server;
  // Tear down the WebSocketServer alongside the HTTP server.
  close: () => Promise<void>;
}

function createHTTPServer(
  info: WSDInfo,
  rpc: ReturnType<typeof createWorkspaceServer>,
): HTTPHandle {
  const server = createServer((request, response) => {
    const path = requestPath(request);

    // /api — capnweb HTTP-batch endpoint. Single POST per call;
    // request body carries the serialized message, response body
    // carries the reply. Useful for environments that can't open
    // a WebSocket (curl, fetch from a Worker without ws upgrade).
    if (path === "/api") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      void serveHTTPBatch(request, response, rpc).catch((error) => {
        console.error("/api batch failed:", error);
        if (!response.headersSent) {
          send(response, 500, "internal error\n", {
            "content-type": "text/plain; charset=utf-8",
          });
        }
      });
      return;
    }

    // /connect — POST { url } where url is the http(s) base of an
    // egress endpoint the host wants us to dial back into. We open a
    // capnweb WebSocket session against `${url}/ws` and serve our RPC
    // over it, exactly like /ws but with the carrier inverted (we
    // dial out instead of accepting an inbound upgrade).
    if (path === "/connect") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      void handleConnect(request, response, rpc);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "method not allowed\n", {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/health") {
      const body = request.method === "HEAD" ? "" : "ok\n";
      send(response, 200, body, {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/__wsd/info") {
      const body = request.method === "HEAD" ? "" : JSON.stringify(info);
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/") {
      const body = request.method === "HEAD" ? "" : "{}";
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    send(response, 404, "not found\n", {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  // /ws — capnweb WebSocket endpoint. Long-lived, bidirectional,
  // streaming-friendly. The container's primary sync carrier.
  // perMessageDeflate compresses each WS frame with zlib. Defaults
  // off in the `ws` package; we turn it on so wsd-to-wsd peers
  // (and any Node-side client that negotiates the extension) save
  // bytes on the wire. Clients that don't advertise the extension
  // negotiate down to plain frames, so no flag day for workerd or
  // browser callers.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  server.on("upgrade", (request, socket, head) => {
    if (requestPath(request) !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

interface ConnectBody {
  // Base URL of the egress endpoint. ws[s]:// or http[s]://; we
  // normalise http(s) to ws(s) and append /ws.
  url?: unknown;
  // How long to poll the upstream /health before giving up.
  // Defaults to 30s; the egress proxy is up at boot but the worker
  // that hosts it may take a tick.
  healthTimeoutMs?: unknown;
}

async function handleConnect(
  request: IncomingMessage,
  response: ServerResponse,
  rpc: ReturnType<typeof createWorkspaceServer>,
): Promise<void> {
  let body: ConnectBody;
  try {
    body = await readJson<ConnectBody>(request);
  } catch (error) {
    send(response, 400, `invalid JSON body: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (typeof body.url !== "string" || body.url.length === 0) {
    send(response, 400, "missing 'url' in body\n", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }
  const baseUrl = body.url.replace(/\/+$/, "");
  const healthTimeoutMs =
    typeof body.healthTimeoutMs === "number" && body.healthTimeoutMs > 0
      ? body.healthTimeoutMs
      : 30_000;

  try {
    await waitForHealth(baseUrl, healthTimeoutMs);
  } catch (error) {
    send(response, 502, `upstream /health unreachable: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  const wsUrl = toWebSocketUrl(baseUrl) + "/ws";
  const ws = new WebSocket(wsUrl);
  ws.once("open", () => {
    console.log(`/connect: attached RPC session to ${wsUrl}`);
    acceptWebSocketSession(ws, rpc);
  });
  ws.once("error", (err) => {
    console.error(`/connect: WebSocket error against ${wsUrl}:`, err.message);
  });
  send(response, 200, `${JSON.stringify({ ok: true, ws: wsUrl })}\n`, {
    "content-type": "application/json; charset=utf-8",
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function toWebSocketUrl(input: string): string {
  if (input.startsWith("ws://") || input.startsWith("wss://")) return input;
  if (input.startsWith("http://")) return `ws://${input.slice("http://".length)}`;
  if (input.startsWith("https://")) return `wss://${input.slice("https://".length)}`;
  throw new Error(`unsupported URL scheme: ${input}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${toHttpUrl(baseUrl)}/health`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${healthUrl} not healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function toHttpUrl(input: string): string {
  if (input.startsWith("ws://")) return `http://${input.slice("ws://".length)}`;
  if (input.startsWith("wss://")) return `https://${input.slice("wss://".length)}`;
  return input;
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const mountPoint = parseMountPoint(process.env.MOUNT_POINT);
  // DISABLE_FUSE=1 skips the FUSE mount entirely. The HTTP server +
  // /api and /ws endpoints stay up so tests and tooling can talk to
  // wsd's RPC surface without needing /dev/fuse. The in-memory store
  // is still real; nothing is mounted on the filesystem.
  const fuseDisabled = process.env.DISABLE_FUSE === "1";
  const backend = fuseDisabled
    ? ({ kind: "none", reason: "DISABLE_FUSE=1" } as const)
    : await detectFUSEBackend();
  if (!fuseDisabled && backend.kind === "none") {
    throw new Error(`FUSE backend unavailable: ${backend.reason}`);
  }

  const upstreamUrl = process.env.UPSTREAM_URL?.trim();
  let upstreamClient: WorkspaceClient | undefined;
  if (upstreamUrl !== undefined && upstreamUrl.length > 0) {
    // Use the `ws` package's WebSocket (not Node's built-in
    // global) so the dial negotiates permessage-deflate against
    // the upstream's WebSocketServer. Node 22's built-in
    // WebSocket doesn't advertise the deflate extension.
    upstreamClient = createWorkspaceClient({
      url: upstreamUrl,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
  }
  const { vfs, db, stopSync } = await createNodeVirtualFileSystem({
    upstream: upstreamClient?.sync,
  });
  const info: WSDInfo = { backend, mountPoint, port };

  let fuse: FuseMount | undefined;
  if (!fuseDisabled) {
    await mkdir(mountPoint, { recursive: true });
    fuse = await mountFuse({
      backend: backend as Exclude<FUSEBackend, { kind: "none" }>,
      mountPoint,
      vfs,
    });
  }
  // EXEC_LOG_MAX_BYTES lets the harness force size-cap eviction
  // without rebuilding the binary. Default lives in the Runner.
  const logMaxBytesEnv = process.env.EXEC_LOG_MAX_BYTES;
  const runner = new Runner({
    db,
    ...(logMaxBytesEnv !== undefined && logMaxBytesEnv !== ""
      ? { logMaxBytes: Number(logMaxBytesEnv) }
      : {}),
  });
  const rpc = createWorkspaceServer(db, runner);
  const http = createHTTPServer(info, rpc);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await http.close();
    } catch (error) {
      console.error(error);
    }
    try {
      runner.disposeAll();
    } catch (error) {
      console.error(error);
    }

    if (fuse !== undefined) {
      await unmount(fuse);
    }
    if (upstreamClient !== undefined) {
      try {
        stopSync();
        await upstreamClient.close();
      } catch (error) {
        console.error(error);
      }
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", (signal) => void shutdown(signal));
  process.once("SIGTERM", (signal) => void shutdown(signal));

  await new Promise<void>((resolve) => {
    http.server.listen(port, HOST, () => {
      const address = http.server.address();

      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      info.port = boundPort;
      console.log(
        `wsd listening on ${HOST}:${boundPort} mount=${fuseDisabled ? "(disabled)" : mountPoint} backend=${backend.kind}`,
      );
      resolve();
    });
  });
}

async function unmount(fuse: FuseMount): Promise<void> {
  try {
    await fuse.unmount();
  } catch (error) {
    console.error("failed to unmount FUSE:", error instanceof Error ? error.message : error);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
