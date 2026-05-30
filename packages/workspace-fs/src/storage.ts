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
    return this.sql.exec<Row>(query, ...bindings).toArray();
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
