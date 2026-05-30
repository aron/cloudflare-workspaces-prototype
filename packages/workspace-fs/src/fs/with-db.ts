// Node-backed implementation. Selected by the default vitest config.
// The workers config aliases this module to ./with-db.workers.ts so the
// same test source runs against a real Durable Object.

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";

export interface WithDBOptions {
  now?: () => number;
}

export async function withDB<T>(
  fn: (db: Database) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, options.now ?? (() => 1000));
  try {
    return await fn(db);
  } finally {
    storage.close();
  }
}
