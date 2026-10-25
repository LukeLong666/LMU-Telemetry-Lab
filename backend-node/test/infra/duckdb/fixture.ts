import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Synthetic session database. There is no `testdata/duckdb/` asset in this repo
 * (the Java README references one that was never committed), so the tests build
 * their own database with the same tables/columns the SQL in DuckDbReads.java
 * reads: frame tables expose `value`, event tables expose `ts` + `value`,
 * wheel tables `ts` + `value1`..`value4`, plus the `metadata` table.
 */
export interface TestDatabase {
  readonly dir: string;
  readonly database: string;
  dispose(): void;
}

export function makeTempDir(prefix = 'lmutl-duckdb-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Creates (or rewrites) a DuckDB file with the given statements, closing it properly. */
export async function runStatements(database: string, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(database);
  try {
    const connection = await instance.connect();
    try {
      for (const statement of statements) {
        await connection.run(statement);
      }
    } finally {
      connection.disconnectSync();
    }
  } finally {
    instance.closeSync();
  }
}

export const SESSION_FIXTURE_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" VALUES (10.5), (20.25), (CAST(NULL AS DOUBLE)), (30.75)',
  'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Lap" VALUES (12.0, 1.0), (25.0, 2.0)',
  'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Lap Time" VALUES (24.0, 12.0), (30.0, 0.0)',
  'CREATE TABLE "In Pits" (ts DOUBLE, value BOOLEAN)',
  "INSERT INTO \"In Pits\" VALUES (11.0, true), (26.0, false)",
  'CREATE TABLE "Tyre Loads" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
  'INSERT INTO "Tyre Loads" VALUES (5.0, 1.0, 2.0, 3.0, 4.0), (13.0, 5.0, CAST(NULL AS DOUBLE), 7.0, 8.0), (27.0, 9.0, 10.0, 11.0, 12.0)',
  'CREATE TABLE "Ground Speed" (value DOUBLE)',
  'INSERT INTO "Ground Speed" VALUES (100.0), (101.5), (CAST(NULL AS DOUBLE)), (103.0)',
  'CREATE TABLE "Gear" (ts DOUBLE, value INTEGER)',
  'INSERT INTO "Gear" VALUES (1.0, 3), (2.0, CAST(NULL AS INTEGER)), (4.0, 5)',
  'CREATE TABLE "Setup" (ts DOUBLE, "Throttle" DOUBLE, "Brake" DOUBLE)',
  'INSERT INTO "Setup" VALUES (1.0, 0.8, 0.0), (2.0, 0.2, 0.4)',
  'CREATE TABLE "Odd" (ts VARCHAR, value DOUBLE)',
  "INSERT INTO \"Odd\" VALUES ('abc', 1.0), ('2.5', 2.0)",
  'CREATE TABLE "Strings" (value VARCHAR)',
  "INSERT INTO \"Strings\" VALUES ('1.5d'), ('7'), ('abc'), ('1e3'), (CAST(NULL AS VARCHAR))",
  'CREATE TABLE "Counters" (value BIGINT)',
  'INSERT INTO "Counters" VALUES (42), (CAST(NULL AS BIGINT)), (-7)',
  'CREATE TABLE "Decimals" (value DECIMAL(10,3))',
  'INSERT INTO "Decimals" VALUES (1.9), (-1.9), (CAST(NULL AS DECIMAL(10,3)))',
  'CREATE TABLE "Frames" (value DOUBLE)',
  'INSERT INTO "Frames" SELECT x / 2.0 FROM range(5000) t(x)',
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Spa-Francorchamps'), ('CarName', CAST(NULL AS VARCHAR)), ('SessionTime', '   '), ('CarClass', 'GTP')",
];

export async function createSessionFixture(dir = makeTempDir()): Promise<TestDatabase> {
  const database = path.join(dir, 'session.duckdb');
  await runStatements(database, SESSION_FIXTURE_SQL);
  return {
    dir,
    database,
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
