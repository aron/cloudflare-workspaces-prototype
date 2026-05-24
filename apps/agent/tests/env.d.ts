/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:workers" {
  interface Env {
    AppDO:  DurableObjectNamespace<import("../src/app-do").AppDO>;
    RoomDO: DurableObjectNamespace<import("../src/room-do").RoomDO>;
  }
}
