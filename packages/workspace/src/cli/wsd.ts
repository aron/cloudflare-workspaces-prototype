#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DEFAULT_PORT = 4567;
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

const server = createServer((request, response) => {
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

function closeThenExit(signal: NodeJS.Signals): void {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }

    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

process.once("SIGINT", closeThenExit);
process.once("SIGTERM", closeThenExit);

try {
  const port = parsePort(process.env.PORT);
  server.listen(port, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    console.log(`wsd listening on ${HOST}:${boundPort}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
