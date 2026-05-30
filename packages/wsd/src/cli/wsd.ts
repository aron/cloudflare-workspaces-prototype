#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { createSyncClient, type SyncClient } from "@cloudflare/workspace-rpc/client";
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

function createHTTPServer(info: WSDInfo): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "method not allowed\n", {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    const path = requestPath(request);
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
  const backend = await detectFUSEBackend();
  if (backend.kind === "none") {
    throw new Error(`FUSE backend unavailable: ${backend.reason}`);
  }

  const upstreamUrl = process.env.UPSTREAM_URL?.trim();
  let upstreamClient: SyncClient | undefined;
  if (upstreamUrl !== undefined && upstreamUrl.length > 0) {
    upstreamClient = createSyncClient({ url: upstreamUrl });
  }
  const vfs = await createNodeVirtualFileSystem({ upstream: upstreamClient });
  const info: WSDInfo = { backend, mountPoint, port };

  await mkdir(mountPoint, { recursive: true });
  const fuse = await mountFuse({ backend, mountPoint, vfs });
  const server = createHTTPServer(info);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await closeServer(server);
    } catch (error) {
      console.error(error);
    }

    await unmount(fuse);
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
    server.listen(port, HOST, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      info.port = boundPort;
      console.log(
        `wsd listening on ${HOST}:${boundPort} mount=${mountPoint} backend=${backend.kind}`,
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
