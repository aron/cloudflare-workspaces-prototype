// CloudflareContainerBackend tests — exercise the lifecycle
// plumbing against an in-process fake Container.
//
// The successful connect() path constructs a WebSocketPair, which
// is a workerd global not available under the vitest node runner.
// These tests cover the paths that bail before the upgrade (port
// never opens, /connect non-2xx, /ws upgrade timeout) and the
// handleFetch input validation. The full happy-path round-trip is
// covered by the live example.

import { describe, expect, test, vi } from "vitest";

import { CloudflareContainerBackend } from "./cloudflare-container.js";

interface FakeContainerOptions {
  healthy?: boolean;
  connectStatus?: number;
}

function makeFakeContainer(opts: FakeContainerOptions = {}) {
  const healthy = opts.healthy ?? true;
  const connectStatus = opts.connectStatus ?? 200;

  const calls: { name: string; args: unknown[] }[] = [];
  let running = false;
  let interceptedHost: string | undefined;
  let interceptedFetcher: Fetcher | undefined;

  const portFetcher: Fetcher = {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    fetch: vi.fn(async (input: any, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? (typeof input === "string" ? "GET" : input.method);
      calls.push({ name: "port.fetch", args: [url, method] });

      if (url.endsWith("/health")) {
        if (!healthy) throw new Error("connection refused");
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/connect")) {
        if (connectStatus !== 200) {
          return new Response(`/connect ${connectStatus}`, { status: connectStatus });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected port fetch: ${url}`);
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;

  const container = {
    get running() {
      return running;
    },
    start(options: unknown) {
      calls.push({ name: "start", args: [options] });
      running = true;
    },
    async monitor() {
      calls.push({ name: "monitor", args: [] });
      return new Promise<void>(() => {});
    },
    async interceptOutboundHttp(addr: string, binding: Fetcher) {
      calls.push({ name: "interceptOutboundHttp", args: [addr] });
      interceptedHost = addr;
      interceptedFetcher = binding;
    },
    getTcpPort(_port: number): Fetcher {
      return portFetcher;
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any as Container;

  return {
    container,
    calls,
    get interceptedHost() {
      return interceptedHost;
    },
    get interceptedFetcher() {
      return interceptedFetcher;
    },
  };
}

const fakeEgress: Fetcher = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  fetch: vi.fn(async () => new Response("ok")) as any,
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
} as any;

describe("CloudflareContainerBackend", () => {
  test("connect() throws when the container port never opens", async () => {
    const fake = makeFakeContainer({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/container port 8080 did not open/);

    // Confirm the lifecycle steps the backend did get to.
    const names = fake.calls.map((c) => c.name);
    expect(names).toContain("start");
    expect(names).toContain("interceptOutboundHttp");
    expect(fake.interceptedHost).toBe("workspace.internal");
    expect(fake.interceptedFetcher).toBe(fakeEgress);
  });

  test("egressHost option overrides the default", async () => {
    const fake = makeFakeContainer({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
      egressHost: "wsd.local",
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(fake.interceptedHost).toBe("wsd.local");
  });

  test("containerEnv option merges onto the start() env", async () => {
    const fake = makeFakeContainer({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
      containerEnv: { CUSTOM: "1", PORT: "9000" },
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    const startCall = fake.calls.find((c) => c.name === "start");
    expect(startCall).toBeDefined();
    const options = startCall?.args[0] as { env?: Record<string, string> };
    expect(options.env?.CUSTOM).toBe("1");
    // Caller-supplied value wins over the default.
    expect(options.env?.PORT).toBe("9000");
    // Defaults still flow through.
    expect(options.env?.MOUNT_POINT).toBe("/workspace");
  });

  test("connect() throws when /connect returns non-2xx", async () => {
    const fake = makeFakeContainer({ connectStatus: 502 });
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/POST \/connect returned 502/);
  });

  test("connect() throws when the /ws upgrade never arrives", async () => {
    const fake = makeFakeContainer();
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/\/ws upgrade did not arrive/);
  });

  test("handleFetch rejects non-/ws paths", async () => {
    const fake = makeFakeContainer();
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
    });
    const res = await backend.handleFetch(new Request("http://workspace.internal/other"));
    expect(res.status).toBe(404);
  });

  test("handleFetch rejects missing upgrade header", async () => {
    const fake = makeFakeContainer();
    const backend = new CloudflareContainerBackend({
      container: () => fake.container,
      egress: fakeEgress,
    });
    const res = await backend.handleFetch(new Request("http://workspace.internal/ws"));
    expect(res.status).toBe(426);
  });
});
