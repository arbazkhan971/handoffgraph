/** Minimal D1 surface shared by Worker modules and plain-object unit tests. */

export interface D1ResultMetaLike {
  /** Rows changed by INSERT/UPDATE/DELETE. */
  changes?: number;
  last_row_id?: number | string;
  [key: string]: unknown;
}

export interface D1RunResultLike<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: D1ResultMetaLike;
}

export interface D1AllResultLike<T = unknown> {
  results: T[];
  success?: boolean;
  meta?: D1ResultMetaLike;
}

export interface D1BoundStatement {
  first<T = unknown>(columnName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1AllResultLike<T>>;
  run<T = unknown>(): Promise<D1RunResultLike<T>>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1BoundStatement;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
  batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]>;
}
