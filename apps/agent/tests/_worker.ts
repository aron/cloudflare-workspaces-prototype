/**
 * Test-only Worker entry. `@cloudflare/vitest-pool-workers` needs a real
 * Worker `main` so it can bind the DOs; the fetch handler is unused (tests
 * call DO stubs directly via `env`).
 *
 * We also export a `FakeAgent` here. It stands in for the real `Agent` DO
 * in tests where we only want to observe what Room sends to it (e.g.
 * `POST /seed` after minting a thread). Recording is per-DO-instance:
 * each thread id gets its own FakeAgent state.
 */
import { DurableObject } from "cloudflare:workers";
import { App }  from "../src/app.js";
import { Room } from "../src/room.js";

export { App, Room };

interface RecordedCall {
  method: string;
  path:   string;
  body:   unknown;
}

export class FakeAgent extends DurableObject<unknown> {
  private calls: RecordedCall[] = [];

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") {
      return Response.json({ calls: this.calls });
    }
    let body: unknown = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const text = await request.text();
      try { body = text ? JSON.parse(text) : null; }
      catch { body = text; }
    }
    this.calls.push({ method: request.method, path: url.pathname, body });
    return Response.json({ ok: true });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker — call DOs directly via env", { status: 404 });
  },
} satisfies ExportedHandler<unknown>;
