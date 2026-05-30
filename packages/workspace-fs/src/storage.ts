import type { DurableObjectStorageLike, SqlStorageLike } from "./types.js";

export class Database {
  readonly sql: SqlStorageLike;
  readonly transactionSync: <T>(closure: () => T) => T;

  constructor(storage: DurableObjectStorageLike) {
    this.sql = storage.sql;
    this.transactionSync = <T>(closure: () => T): T => {
      if (storage.transactionSync !== undefined) {
        return storage.transactionSync(closure);
      }

      if (storage.transaction !== undefined) {
        const result = storage.transaction(closure);
        if (
          result !== undefined &&
          result !== null &&
          typeof result === "object" &&
          "then" in result
        ) {
          throw new Error("Durable Object storage adapter requires synchronous transactions");
        }
        return result;
      }

      return closure();
    };
  }

  run(query: string, ...bindings: unknown[]): void {
    this.sql.exec(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    const rows = this.sql.exec<Row>(query, ...bindings).toArray();
    return rows.map(normalizeRow) as Row[];
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    if (row === undefined) {
      return undefined;
    }

    const [value] = Object.values(row);
    return value;
  }
}

// Cloudflare's DO SqlStorage returns BLOB columns as ArrayBuffer,
// whereas node:sqlite returns Uint8Array. Normalise to Uint8Array so
// the rest of the code only has to handle one shape.
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof ArrayBuffer) {
      if (out === undefined) out = { ...row };
      out[key] = new Uint8Array(value);
    }
  }
  return out ?? row;
}
