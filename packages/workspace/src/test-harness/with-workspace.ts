// Harness helper: run a callback against a fresh Workspace whose
// local store is a real DurableObject's ctx.storage. Each call
// gets a fresh DO instance so tests don't bleed into each other.

import { env, runInDurableObject } from "cloudflare:test";

import { TestBackend, Workspace, type WorkspaceBackend } from "../index.js";
import type { HarnessBindings } from "../test-harness-worker.js";

function freshStub() {
  const bindings = env as unknown as HarnessBindings;
  const id = bindings.TEST_DO.newUniqueId();
  return bindings.TEST_DO.get(id);
}

export async function withWorkspace<T>(
  url: string,
  fn: (ws: Workspace) => T | Promise<T>,
  extraBackends: WorkspaceBackend[] = [],
): Promise<T> {
  const stub = freshStub();
  // biome-ignore lint/suspicious/noExplicitAny: cloudflare:test types aren't on the typecheck path
  return runInDurableObject(stub, async (_instance: any, state: any) => {
    const ws = new Workspace({
      storage: state.storage,
      backends: [new TestBackend({ url }), ...extraBackends],
    });
    try {
      return await fn(ws);
    } finally {
      await ws.close();
    }
  });
}
