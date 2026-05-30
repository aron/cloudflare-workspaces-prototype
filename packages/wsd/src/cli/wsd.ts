#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { createSyncClient, type SyncClient } from "@cloudflare/workspace-rpc/client";
import { acceptWebSocketSession, createSyncServer } from "@cloudflare/workspace-rpc/server";
import { nodeHttpBatchRpcResponse } from "capnweb";
import { WebSocketServer } from "ws";
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

function createHTTPServer(info: WSDInfo, rpc: ReturnType<typeof createSyncServer>): HTTPHandle {
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
      void nodeHttpBatchRpcResponse(request, response, rpc).catch((error) => {
        console.error("/api batch failed:", error);
        if (!response.headersSent) {
          send(response, 500, "internal error\n", {
            "content-type": "text/plain; charset=utf-8",
          });
        }
      });
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
  const wss = new WebSocketServer({ noServer: true });
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
  let upstreamClient: SyncClient | undefined;
  if (upstreamUrl !== undefined && upstreamUrl.length > 0) {
    upstreamClient = createSyncClient({ url: upstreamUrl });
  }
  const { vfs, db } = await createNodeVirtualFileSystem({ upstream: upstreamClient });
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
  const rpc = createSyncServer(db);
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

    if (fuse !== undefined) {
      await unmount(fuse);
    }
    if (upstreamClient !== undefined) {
      try {
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
