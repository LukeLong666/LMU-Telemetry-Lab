import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Synthetic LMU session database for the fusion tests.
 *
 * There is no `testdata/duckdb/` asset in this repository (the Java README names a
 * `synthetic_monza_multistint.duckdb` that was never committed, and `FusionEngineTest`
 * skipped itself when it was absent), so the database is generated here with
 * `@duckdb/node-api` in write mode. Table and column names are exactly the ones the SQL
 * in `DuckDbReads.java` / `FusionEngine.java` references; the shapes are chosen so every
 * fusion branch has something to bite on:
 *
 *   - a 121-row 1 Hz `GPS Time` (0..120 s) and a 10 Hz master grid over it (1201 frames);
 *   - two stints: `Lap` events at 30 s and 70 s plus a pit stop between 60 s and 70 s, so
 *     lap segments restart the distance and boundaries fall exactly on grid points;
 *   - change-only event tables (`Gear`, `ABS`, `TyresCompound`, `TCCut`, `In Pits`), a
 *     per-wheel event table (`Wheel ABS`, `WheelTC`, `Tyre Loads`, `Wheel Speed`,
 *     `TyresTemp*`) and frame tables sampled at a *different* rate (`RPM` has 61 rows for
 *     121 GPS rows) to exercise the index-to-time resampling;
 *   - SQL NULLs in `Throttle Pos`, `Tyre Loads` and `Setup` (numeric NULL -> NaN);
 *   - a `metadata` row set that resolves to Silverstone / National Circuit, whose official
 *     length (2639 m) makes exactly two of the three lap segments fall inside the
 *     0.8..1.2 scaling window and one outside it;
 *   - tables on the skip list (`GPS Speed`, `Throttle Pos Unfiltered`, `Lap Dist`) so the
 *     skip and the `Ground Speed` -> `GPS Speed` fallback are both reachable.
 *
 * The session is designed so expected values can be derived on paper: `Ground Speed` is a
 * constant 216 km/h (max > 150, so the engine divides by 3.6 -> 60 m/s), which integrates
 * to exactly 6 m per master frame at 10 Hz.
 */

/** Default session bounds and grid used by the fixture. */
export const GPS_LAST = 120;
export const GPS_ROW_COUNT = 121;
export const SPEED_KMH = 216;
export const LAP_DIST_INITIAL_OFFSET = 100;
export const TRACK_NAME = 'Silverstone';
export const TRACK_LAYOUT = 'National Circuit';
export const CAR_NAME = 'United Autosports';
export const CAR_CLASS = 'LMGT3';

/** A generated table: its name (for `omitTables`) plus the DDL/DML that creates it. */
export interface FixtureTable {
  readonly table: string;
  readonly sql: readonly string[];
}

export interface DuckDbFixture {
  readonly dir: string;
  readonly database: string;
  dispose(): void;
}

export interface FusionFixtureOptions {
  /** Tables to leave out entirely, e.g. `['Ground Speed']` to test the GPS Speed fallback. */
  readonly omitTables?: readonly string[];
  /** Extra or overriding `metadata` rows (a null value inserts SQL NULL). */
  readonly metadata?: Readonly<Record<string, string | null>>;
  /** Directory to write into; a fresh mkdtemp under os.tmpdir() when omitted. */
  readonly dir?: string;
  /** File name inside `dir`; defaults to `fusion-session.duckdb`. */
  readonly databaseName?: string;
}

const DEFAULT_METADATA: Readonly<Record<string, string | null>> = {
  TrackName: TRACK_NAME,
  TrackLayout: TRACK_LAYOUT,
  CarName: CAR_NAME,
  CarClass: CAR_CLASS,
  DriverName: null,
};

/**
 * Every numeric series below is a constant or an `x`-indexed expression over
 * `range(121)`, i.e. one row per GPS timestamp (1 Hz), unless stated otherwise.
 */
export const FUSION_FIXTURE_TABLES: readonly FixtureTable[] = [
  {
    table: 'GPS Time',
    sql: [
      'CREATE TABLE "GPS Time" (value DOUBLE)',
      'INSERT INTO "GPS Time" SELECT CAST(x AS DOUBLE) FROM range(121) t(x)',
    ],
  },
  {
    table: 'Lap',
    sql: [
      'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap" VALUES (30.0, 2.0), (70.0, 3.0)',
    ],
  },
  {
    table: 'Lap Time',
    sql: [
      'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap Time" VALUES (30.0, 25.0), (70.0, 40.0)',
    ],
  },
  {
    // Only the first row matters: it is the distance the session had already covered.
    table: 'Lap Dist',
    sql: [
      'CREATE TABLE "Lap Dist" (value DOUBLE)',
      'INSERT INTO "Lap Dist" SELECT 100.0 + x * 6.0 FROM range(121) t(x)',
    ],
  },
  {
    // Gear 0 then 4 -> the engine rewinds the parked first event to derive gear 3.
    table: 'Gear',
    sql: [
      'CREATE TABLE "Gear" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Gear" VALUES (5.0, 0.0), (12.0, 4.0), (35.0, 5.0), (78.0, 2.0)',
    ],
  },
  {
    table: 'Ground Speed',
    sql: [
      'CREATE TABLE "Ground Speed" (value DOUBLE)',
      `INSERT INTO "Ground Speed" SELECT ${SPEED_KMH}.0 FROM range(121) t(x)`,
    ],
  },
  {
    // Same physical speed in m/s: the fallback source when `Ground Speed` is missing.
    table: 'GPS Speed',
    sql: [
      'CREATE TABLE "GPS Speed" (value DOUBLE)',
      'INSERT INTO "GPS Speed" SELECT 60.0 FROM range(121) t(x)',
    ],
  },
  {
    table: 'Throttle Pos Unfiltered',
    sql: [
      'CREATE TABLE "Throttle Pos Unfiltered" (value DOUBLE)',
      'INSERT INTO "Throttle Pos Unfiltered" SELECT 0.7 FROM range(121) t(x)',
    ],
  },
  {
    table: 'GPS Latitude',
    sql: [
      'CREATE TABLE "GPS Latitude" (value DOUBLE)',
      'INSERT INTO "GPS Latitude" SELECT 45.62 + x * 0.0001 FROM range(121) t(x)',
    ],
  },
  {
    table: 'GPS Longitude',
    sql: [
      'CREATE TABLE "GPS Longitude" (value DOUBLE)',
      'INSERT INTO "GPS Longitude" SELECT 4.41 + x * 0.0002 FROM range(121) t(x)',
    ],
  },
  {
    // Normalised -1..1 steering, so the engine rescales it by steeringLock / 2.
    table: 'Steering Pos',
    sql: [
      'CREATE TABLE "Steering Pos" (value DOUBLE)',
      'INSERT INTO "Steering Pos" SELECT CASE WHEN x % 2 = 0 THEN 0.5 ELSE -0.25 END FROM range(121) t(x)',
    ],
  },
  {
    // NULLs at rows 60 and 61 -> NaN windows around t = 60 s in the fused channel.
    table: 'Throttle Pos',
    sql: [
      'CREATE TABLE "Throttle Pos" (value DOUBLE)',
      'INSERT INTO "Throttle Pos" SELECT CASE WHEN x IN (60, 61) THEN CAST(NULL AS DOUBLE) ELSE 0.8 END FROM range(121) t(x)',
    ],
  },
  {
    // 61 rows for 121 GPS rows: every other second, i.e. a 2 Hz signal on a 1 Hz timeline.
    table: 'RPM',
    sql: [
      'CREATE TABLE "RPM" (value DOUBLE)',
      'INSERT INTO "RPM" SELECT 1000.0 + x * 100.0 FROM range(61) t(x)',
    ],
  },
  {
    // A frame table with an extra column: fused as "Engine Data" and "Engine Data_Oil Pressure".
    table: 'Engine Data',
    sql: [
      'CREATE TABLE "Engine Data" (value DOUBLE, "Oil Pressure" DOUBLE)',
      'INSERT INTO "Engine Data" SELECT 500.0 + x, 3.0 FROM range(121) t(x)',
    ],
  },
  {
    // Wheel frame table (value1..value4, no ts): constant per wheel, both signs.
    table: 'Susp Pos',
    sql: [
      'CREATE TABLE "Susp Pos" (value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "Susp Pos" SELECT -0.5, 0.5, -1.0, 1.5 FROM range(121) t(x)',
    ],
  },
  {
    // Sparse + pulse; the final ABS channel is overwritten by the "Wheel ABS" maximum.
    table: 'ABS',
    sql: [
      'CREATE TABLE "ABS" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "ABS" VALUES (15.0, 1.0), (16.0, 0.0)',
    ],
  },
  {
    // Sparse + pulse: both events round onto frame 201, so the 0 lands on frame 202.
    table: 'TCCut',
    sql: [
      'CREATE TABLE "TCCut" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "TCCut" VALUES (20.04, 1.0), (20.05, 0.0)',
    ],
  },
  {
    table: 'TyresCompound',
    sql: [
      'CREATE TABLE "TyresCompound" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "TyresCompound" VALUES (10.0, 2.0), (75.0, 3.0)',
    ],
  },
  {
    // Sparse + "replace NaN with 0": everything before t = 40 s becomes 0, not NaN.
    table: 'WheelsDetached',
    sql: [
      'CREATE TABLE "WheelsDetached" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "WheelsDetached" VALUES (40.0, 1.0)',
    ],
  },
  {
    // BOOLEAN values -> 1/0; not sparse, so gaps stay NaN.
    table: 'In Pits',
    sql: [
      'CREATE TABLE "In Pits" (ts DOUBLE, value BOOLEAN)',
      'INSERT INTO "In Pits" VALUES (30.0, true), (34.0, false), (70.0, true), (74.0, false)',
    ],
  },
  {
    // Event table without a `value` column -> "Setup_Throttle" / "Setup_Brake".
    table: 'Setup',
    sql: [
      'CREATE TABLE "Setup" (ts DOUBLE, "Throttle" DOUBLE, "Brake" DOUBLE)',
      'INSERT INTO "Setup" VALUES (1.5, 1.0, 0.0), (33.5, CAST(NULL AS DOUBLE), 0.2), (50.5, 0.9, 0.3)',
    ],
  },
  {
    // Per-wheel event table, not sparse: only the two aligned frames carry values.
    table: 'Wheel Speed',
    sql: [
      'CREATE TABLE "Wheel Speed" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "Wheel Speed" VALUES (5.0, 66.0, 60.0, 54.0, 60.0), (60.0, 72.0, 60.0, 48.0, 60.0)',
    ],
  },
  {
    // Sparse wheel events -> per-wheel forward fill, then the max feeds "ABS".
    table: 'Wheel ABS',
    sql: [
      'CREATE TABLE "Wheel ABS" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "Wheel ABS" VALUES (14.0, 1.0, 0.0, 0.0, 0.0), (30.5, 0.0, 1.0, 0.0, 0.0), (50.5, 0.0, 0.0, 0.0, 0.0)',
    ],
  },
  {
    // Underscore variant, feeding "TC" through the fallback name.
    table: 'WheelTC',
    sql: [
      'CREATE TABLE "WheelTC" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "WheelTC" VALUES (22.0, 0.0, 0.0, 0.0, 0.0), (45.5, 1.0, 0.0, 0.0, 0.0)',
    ],
  },
  {
    // NULL inside a wheel row of an event table.
    table: 'Tyre Loads',
    sql: [
      'CREATE TABLE "Tyre Loads" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "Tyre Loads" VALUES (13.0, 1000.0, CAST(NULL AS DOUBLE), 800.0, 900.0)',
    ],
  },
  {
    table: 'TyresTempLeft',
    sql: [
      'CREATE TABLE "TyresTempLeft" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "TyresTempLeft" VALUES (20.0, 80.0, 82.0, 84.0, 86.0), (95.5, 85.0, 87.0, 89.0, 91.0)',
    ],
  },
  {
    table: 'TyresTempCentre',
    sql: [
      'CREATE TABLE "TyresTempCentre" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "TyresTempCentre" VALUES (20.0, 70.0, 72.0, 74.0, 76.0), (95.5, 75.0, 77.0, 79.0, 81.0)',
    ],
  },
  {
    table: 'TyresTempRight',
    sql: [
      'CREATE TABLE "TyresTempRight" (ts DOUBLE, value1 DOUBLE, value2 DOUBLE, value3 DOUBLE, value4 DOUBLE)',
      'INSERT INTO "TyresTempRight" VALUES (20.0, 90.0, 92.0, 94.0, 96.0), (95.5, 95.0, 97.0, 99.0, 101.0)',
    ],
  },
];

export function makeTempDir(prefix = 'lmutl-fusion-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Creates (or rewrites) a DuckDB file with the given statements, then releases the handle. */
export async function writeDatabase(database: string, statements: readonly string[]): Promise<void> {
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

function metadataSql(rows: Readonly<Record<string, string | null>>): string[] {
  const values = Object.entries(rows).map(([key, value]) => {
    const text = value === null ? 'CAST(NULL AS VARCHAR)' : `'${value.replaceAll("'", "''")}'`;
    return `('${key.replaceAll("'", "''")}', ${text})`;
  });
  return [
    'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
    `INSERT INTO metadata VALUES ${values.join(', ')}`,
  ];
}

/** The DDL/DML for the fixture, honouring `omitTables` and `metadata` overrides. */
export function fusionFixtureStatements(options: FusionFixtureOptions = {}): string[] {
  const omitted = new Set(options.omitTables ?? []);
  const statements: string[] = [];
  for (const block of FUSION_FIXTURE_TABLES) {
    if (omitted.has(block.table)) continue;
    statements.push(...block.sql);
  }
  statements.push(...metadataSql({ ...DEFAULT_METADATA, ...(options.metadata ?? {}) }));
  return statements;
}

/** Writes the synthetic session into a temp directory and hands back its path. */
export async function createFusionFixture(options: FusionFixtureOptions = {}): Promise<DuckDbFixture> {
  const dir = options.dir ?? makeTempDir();
  const database = path.join(dir, options.databaseName ?? 'fusion-session.duckdb');
  await writeDatabase(database, fusionFixtureStatements(options));
  return {
    dir,
    database,
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
