/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:workers" {
  interface Env {
    AppDO:  DurableObjectNamespace<import("../src/app-do").AppDO>;
    RoomDO: DurableObjectNamespace<import("../src/room-do").RoomDO>;
    // In tests, the "Agent" binding points at FakeAgent so we can observe
    // what RoomDO sends to the (would-be) Agent DO without booting the real
    // one — which needs AI / Sandbox / LOADER bindings we don't have here.
    Agent:  DurableObjectNamespace<import("./_worker").FakeAgent>;
  }
}
