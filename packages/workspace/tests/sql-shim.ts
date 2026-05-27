/**
 * Minimal SqlStorage shim backed by node:sqlite, plus a transactionSync
 * implementation that matches DurableObjectStorage's contract closely
 * enough for the bits of Vfs / Workspace under test.
 *
 * What it covers:
 *
 *   - `sql.exec(sql, ...bindings)` returning an iterable of result rows
 *     (mirrors the workerd cursor). Iterating once is supported; the
 *     workspace code already collects into arrays via `[...cursor]`.
 *   - `storage.transactionSync(closure)` running the closure inside
 *     `BEGIN`/`COMMIT`, rolling back on throw.
 *
 * What it deliberately doesn't cover:
 *
 *   - The persistent-storage K/V API (`storage.put`, `storage.get`, …).
 *     Vfs only touches `.sql`, so we leave that off.
 *   - Async `transaction()` — Workspace.exec only uses `transactionSync`.
 */

import { DatabaseSync } from "node:sqlite";

type Bind = string | number | bigint | null | Uint8Array | ArrayBuffer | boolean;

function bindable(v: unknown): Bind {
  // workerd accepts booleans; node:sqlite doesn't. Cast to 0/1.
  if (typeof v === "boolean") return v ? 1 : 0;
  // ArrayBuffer → Uint8Array (node:sqlite accepts both, but typing the
  // shim around Uint8Array keeps callers honest).
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Bind;
}

export interface ShimSqlStorage {
  exec<T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Iterable<T>;
}

export interface ShimStorage {
  sql: ShimSqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/**
 * Build a fresh in-memory SqlStorage-compatible shim.  Each call returns
 * its own database, so tests can run in parallel without cross-talk.
 */
export function makeShimStorage(): ShimStorage {
  const db = new DatabaseSync(":memory:");

  // node:sqlite refuses to run multiple statements in a single
  // .exec()-style call when bindings are present, but workerd's
  // sql.exec accepts multi-statement scripts (no bindings) at schema
  // setup time. We split on ';' when there are no bindings to mimic
  // that. Safe for the schema strings the workspace uses, which never
  // embed literal ';' inside string literals.
  function execScript(sql: string): void {
    db.exec(sql);
  }

  const sql: ShimSqlStorage = {
    exec<T = Record<string, unknown>>(sqlText: string, ...bindings: unknown[]): Iterable<T> {
      if (bindings.length === 0 && /;\s*\S/.test(sqlText)) {
        // Multi-statement schema script. node:sqlite's .exec runs all
        // statements in order and returns nothing — the workerd cursor
        // for these is also empty, so we hand back an empty iterable.
        execScript(sqlText);
        return [];
      }
      const stmt = db.prepare(sqlText);
      const binds = bindings.map(bindable);
      // SELECT-style: .all() returns rows.  Other statements: .run()
      // executes and we hand back an empty iterable so callers that do
      // `[...cursor]` get the expected empty array.
      if (/^\s*select\b|^\s*pragma\b|^\s*with\b/i.test(sqlText)) {
        return stmt.all(...binds) as T[];
      }
      stmt.run(...binds);
      return [];
    },
  };

  return {
    sql,
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const out = closure();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    },
  };
}
