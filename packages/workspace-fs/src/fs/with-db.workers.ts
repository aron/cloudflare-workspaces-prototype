// Workers-backed implementation. Vitest config aliases ./with-db.js to
// this file when running under @cloudflare/vitest-pool-workers, so every
// test that calls withDB(fn) ends up driving a real Durable Object's
// SQLite storage instead of a node:sqlite in-memory DB.

import { env, runInDurableObject } from "cloudflare:test";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import type { TestBindings } from "../testing/worker.js";

export interface WithDBOptions {
  now?: () => number;
}

// Each call gets a fresh DO instance so tests don't bleed into each
// other. newUniqueId() gives a name that never collides between runs.
function freshStub() {
  const id = (env as unknown as TestBindings).TEST_DO.newUniqueId();
  return (env as unknown as TestBindings).TEST_DO.get(id);
}

export async function withDB<T>(
  fn: (db: Database) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance, state) => {
    const db = new Database(state.storage);
    initializeSchema(db, options.now ?? (() => 1000));
    return await fn(db);
  });
}
