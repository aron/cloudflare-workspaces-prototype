// TestBackend — the simplest possible backend. Takes a URL
// pointing at an already-running wsd instance and constructs
// a SyncRPC client against it.
//
// No subprocesses, no Docker calls, no file IO. The package
// runs unchanged under workerd — TestBackend is just URL
// plumbing. The test harness outside the package is what
// stands up the wsd container and exposes its port.

import { createSyncClient } from "@cloudflare/workspace-rpc/client";

import type { BackendHandle, WorkspaceBackend } from "../backend.js";

export interface TestBackendOptions {
  // URL pointing at the wsd HTTP server. ws://, wss://,
  // http://, and https:// are all accepted; the http(s)
  // schemes are normalised to ws(s) when constructing the
  // capnweb WebSocket session.
  url: string;
}

export class TestBackend implements WorkspaceBackend {
  readonly id = "test";
  readonly #url: string;

  constructor(options: TestBackendOptions) {
    this.#url = options.url;
  }

  async connect(): Promise<BackendHandle> {
    const wsUrl = toWebSocketUrl(this.#url);
    // Probe /health before constructing the RPC stub. capnweb's
    // WebSocket session queues calls until the upgrade succeeds,
    // so we'd otherwise discover a misconfigured URL only on the
    // first RPC. The probe surfaces "harness forgot to start the
    // container" up front.
    await probeHealth(this.#url);
    const client = createSyncClient({ url: `${wsUrl}/ws` });
    return {
      rpc: client,
      close: async () => {
        await client.close();
      },
    };
  }
}

function toWebSocketUrl(input: string): string {
  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    return stripTrailingSlash(input);
  }
  if (input.startsWith("http://")) {
    return stripTrailingSlash(`ws://${input.slice("http://".length)}`);
  }
  if (input.startsWith("https://")) {
    return stripTrailingSlash(`wss://${input.slice("https://".length)}`);
  }
  throw new Error(`TestBackend: unsupported URL scheme in ${input}`);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function probeHealth(url: string): Promise<void> {
  const healthUrl = `${stripTrailingSlash(toHttpUrl(url))}/health`;
  let response: Response;
  try {
    response = await fetch(healthUrl);
  } catch (cause) {
    throw new Error(
      `TestBackend: ${healthUrl} is not reachable. ` +
        `Is the wsd container running? (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (!response.ok) {
    throw new Error(`TestBackend: ${healthUrl} returned ${response.status} ${response.statusText}`);
  }
}

function toHttpUrl(input: string): string {
  if (input.startsWith("ws://")) return `http://${input.slice("ws://".length)}`;
  if (input.startsWith("wss://")) return `https://${input.slice("wss://".length)}`;
  return input;
}
