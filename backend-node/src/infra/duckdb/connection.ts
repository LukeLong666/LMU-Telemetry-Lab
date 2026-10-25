import path from 'node:path';
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBMaterializedResult,
  type DuckDBResult,
  type DuckDBResultReader,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';

/** Positional (`$1`) or named (`$name`) bind values, as taken by `@duckdb/node-api`. */
export type BindValues = DuckDBValue[] | Record<string, DuckDBValue>;
export type BindTypes = DuckDBType[] | Record<string, DuckDBType | undefined>;

/**
 * DuckDB wants forward slashes on Windows, exactly like the JDBC URL built in
 * DuckDbConnectionFactory.java (`toAbsolutePath().normalize()` + `\` -> `/`).
 */
function toDatabasePath(database: string): string {
  return path.resolve(database).replace(/\\/g, '/');
}

/**
 * One open DuckDB database: the connection plus the instance that owns the file.
 *
 * `close()` must always run - an open instance keeps an exclusive handle on the
 * `.duckdb` file, which on Windows leaks until process exit and blocks the game
 * (and the tests) from touching the file again. Mirrors Java's
 * try-with-resources around `DriverManager.getConnection(...)`.
 */
export class DuckDbSession {
  private closed = false;

  constructor(
    readonly database: string,
    private readonly instance: DuckDBInstance,
    readonly connection: DuckDBConnection,
  ) {}

  /** Whether close() has run; further queries on this session are unsafe. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Materialized query - the equivalent of `Statement.executeQuery` / `Statement.execute`. */
  run(sql: string, values?: BindValues, types?: BindTypes): Promise<DuckDBMaterializedResult> {
    return this.connection.run(sql, values, types);
  }

  /** Materialized query read into a row/column reader. */
  runAndReadAll(
    sql: string,
    values?: BindValues,
    types?: BindTypes,
  ): Promise<DuckDBResultReader> {
    return this.connection.runAndReadAll(sql, values, types);
  }

  /** Streaming result: iterate chunks without materializing the whole query. */
  stream(sql: string, values?: BindValues, types?: BindTypes): Promise<DuckDBResult> {
    return this.connection.stream(sql, values, types);
  }

  /** Release the connection, then the instance. Idempotent; safe from `finally`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.disconnectSync();
    } finally {
      this.instance.closeSync();
    }
  }
}

/**
 * Opens session databases. Mirrors DuckDbConnectionFactory.java: one instance per
 * file, opened per request and closed as soon as the request is done.
 *
 * `open()` is read-only, which is what every reader in this backend needs and is
 * required while the game is still writing the file. `openReadWrite()` exists for
 * the export path (LapExportService) that creates/attaches output databases.
 */
export class DuckDbConnectionFactory {
  /** Read-only open of an existing session file; fails if the file is missing. */
  async open(database: string): Promise<DuckDbSession> {
    return this.openWith(database, { access_mode: 'read_only' });
  }

  /** Read-write open, used only where the backend creates or mutates a database. */
  async openReadWrite(database: string): Promise<DuckDbSession> {
    return this.openWith(database, undefined);
  }

  /** Open read-only, run the callback, always close - the try-with-resources of Java. */
  async withConnection<T>(database: string, read: (session: DuckDbSession) => Promise<T>): Promise<T> {
    const session = await this.open(database);
    try {
      return await read(session);
    } finally {
      session.close();
    }
  }

  /** `withConnection` for the write path. */
  async withReadWriteConnection<T>(
    database: string,
    write: (session: DuckDbSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.openReadWrite(database);
    try {
      return await write(session);
    } finally {
      session.close();
    }
  }

  private async openWith(
    database: string,
    options: Record<string, string> | undefined,
  ): Promise<DuckDbSession> {
    const resolved = toDatabasePath(database);
    const instance = await DuckDBInstance.create(resolved, options);
    try {
      return new DuckDbSession(resolved, instance, await instance.connect());
    } catch (error) {
      instance.closeSync();
      throw error;
    }
  }
}
