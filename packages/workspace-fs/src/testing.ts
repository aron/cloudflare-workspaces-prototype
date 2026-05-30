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
    if (normalized === "select v from cf_vfs_meta where k = ?") {
      const key = String(bindings[0]);
      const value = this.meta.get(key);
      return value === undefined ? [] : ([{ v: value }] as Row[]);
    }

    if (normalized.startsWith("insert or ignore into cf_vfs_meta")) {
      const key = String(bindings[0]);
      const value = Number(bindings[1]);
      if (!this.meta.has(key)) {
        this.meta.set(key, value);
      }
    }

    if (normalized.startsWith("update cf_vfs_meta set v = ? where k = ?")) {
      this.meta.set(String(bindings[1]), Number(bindings[0]));
    }

    return [];
  }
}
