/**
 * Test-only Worker entry. `@cloudflare/vitest-pool-workers` needs a real
 * Worker `main` so it can bind the DOs; the fetch handler is unused (tests
 * call DO stubs directly via `env`).
 */
import { AppDO } from "../src/app-do.js";
import { RoomDO } from "../src/room-do.js";

export { AppDO, RoomDO };

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker — call DOs directly via env", { status: 404 });
  },
} satisfies ExportedHandler<unknown>;
