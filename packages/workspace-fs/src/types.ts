export interface SqlCursorLike<Row extends object = Record<string, unknown>> {
  toArray(): Row[];
}

export interface SqlStorageLike {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursorLike<Row>;
}

export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}
