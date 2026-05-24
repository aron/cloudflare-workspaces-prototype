/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:workers" {
  interface Env {
    App:  DurableObjectNamespace<import("../src/app").App>;
    Room: DurableObjectNamespace<import("../src/room").Room>;
    // In tests, the "Agent" binding points at FakeAgent so we can observe
    // what Room sends to the (would-be) Agent DO without booting the real
    // one — which needs AI / Sandbox / LOADER bindings we don't have here.
    Agent:  DurableObjectNamespace<import("./_worker").FakeAgent>;
  }
}
