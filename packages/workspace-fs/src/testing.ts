import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DurableObjectStorageLike, SqlCursorLike } from "./types.js";

export interface ExecutedStatement {
  query: string;
  bindings: unknown[];
}

class TestCursor<Row extends object> implements SqlCursorLike<Row> {
  private readonly rows: Row[];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  toArray(): Row[] {
    return this.rows;
  }
}

export class RecordingStorage implements DurableObjectStorageLike {
  readonly statements: ExecutedStatement[] = [];
  readonly sql = {
    exec: <Row extends object = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlCursorLike<Row> => {
      this.statements.push({ query, bindings });
      return new TestCursor<Row>(this.rowsFor<Row>(query, bindings));
    },
  };

  private readonly meta = new Map<string, number>();

  constructor(seed?: { schemaVersion?: number; rev?: number }) {
    if (seed?.schemaVersion !== undefined) {
      this.meta.set("schema_version", seed.schemaVersion);
    }
    if (seed?.rev !== undefined) {
      this.meta.set("rev", seed.rev);
    }
  }

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  private rowsFor<Row extends object>(query: string, bindings: unknown[]): Row[] {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized === "select v from vfs_meta where k = ?") {
      const key = String(bindings[0]);
      const value = this.meta.get(key);
      return value === undefined ? [] : ([{ v: value }] as Row[]);
    }

    if (normalized.startsWith("insert or ignore into vfs_meta")) {
      const key = String(bindings[0]);
      const value = Number(bindings[1]);
      if (!this.meta.has(key)) {
        this.meta.set(key, value);
      }
    }

    if (normalized.startsWith("update vfs_meta set v = ? where k = ?")) {
      this.meta.set(String(bindings[1]), Number(bindings[0]));
    }

    return [];
  }
}

// Real-DB DurableObjectStorageLike for unit tests. Backed by Node's
// built-in node:sqlite running an in-memory database. Workers' DO SQL
// surface is a subset of this, so anything that works here works on the
// real platform too.
export class SqliteTestStorage implements DurableObjectStorageLike {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  readonly sql: {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => SqlCursorLike<Row>;
  };

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row> => {
        // node:sqlite refuses statements with trailing whitespace through
        // prepare(); also we cache prepared statements per unique query
        // string to keep the fixture fast.
        const key = query;
        let stmt = this.cache.get(key);
        if (stmt === undefined) {
          stmt = this.db.prepare(query);
          this.cache.set(key, stmt);
        }
        const normalizedBindings = bindings.map(toSqliteValue);
        const rows = (stmt.all(...(normalizedBindings as never[])) as Row[]) ?? [];
        return new TestCursor<Row>(rows);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = closure();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    for (const stmt of this.cache.values()) {
      stmt.finalize?.();
    }
    this.cache.clear();
    this.db.close();
  }
}

// node:sqlite is strict about input shapes: it accepts strings, numbers,
// bigints, null, and Uint8Array but not undefined, Buffer subclasses
// other than Uint8Array, or booleans. Normalize.
function toSqliteValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  throw new TypeError(`SqliteTestStorage cannot bind value of type ${typeof value}`);
}
