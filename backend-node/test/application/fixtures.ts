/**
 * Minimal synthetic session databases for the ported lap chain (lap-service.ts /
 * reference-lap-service.ts). Deliberately self-contained - it is scoped to the SQL that
 * `LapService` actually issues, so it does not overlap with `test/helpers/duckdb-fixture.ts`
 * (the shared fusion fixture) or `test/infra/duckdb/fixture.ts`.
 *
 * Tables referenced by LapService.java / LapBoundaryResolver.java / DuckDbReads.java:
 *   frame tables (single `value` column, read with `ORDER BY rowid`):
 *     "GPS Time", "GPS Latitude", "GPS Longitude", "Fuel Level", "Lap Dist"
 *   event tables (`ts`, `value`, read with `ORDER BY ts`):
 *     "Lap", "Lap Time", "Last Sector1", "Last Sector2", "In Pits"
 *   key/value: metadata (key, value)
 *
 * MAIN_SESSION_SQL is hand-built so every lap row exercises one settled Java rule; the
 * expected rows are documented next to the data below and asserted literally in
 * lap-service.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import pino from 'pino';
import type { Logger } from '../../src/lib/log.js';
import type { Env } from '../../src/config/env.js';
import { AppPaths } from '../../src/infra/fs/app-paths.js';

/** Silent logger: the services log on their normal paths (cache misses, skipped files). */
export const fixtureLogger: Logger = pino({ level: 'silent' });

const FIXTURE_PREFIX = 'lmutl-lap-service-';
let fixtureRoot: string | null = null;

/** One mkdtemp directory per test file run; every database is built inside it. */
export function lapFixtureRoot(): string {
  if (fixtureRoot === null) {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  }
  return fixtureRoot;
}

/** Removes the temp root. Call from `afterAll`. */
export function cleanupLapFixtures(): void {
  if (fixtureRoot !== null) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
}

/** Runs the statements against a fresh DuckDB file and closes it, releasing the handle. */
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

/** Builds `fileName` in the fixture root and returns its absolute path. */
export async function buildSessionDatabase(
  fileName: string,
  statements: readonly string[],
): Promise<string> {
  const file = path.join(lapFixtureRoot(), fileName);
  await runStatements(file, statements);
  return file;
}

/** An `Env` that keeps all app data under `root` and disables the game telemetry folder. */
export function fixtureEnv(root: string): Env {
  return {
    port: 0,
    address: '127.0.0.1',
    devMode: true,
    dataDir: path.join(root, 'data'),
    telemetryDir: '',
    frontendDir: path.join(root, 'frontend', 'dist'),
    steeringWheelDir: path.join(root, 'frontend', 'public', 'steering wheel'),
    version: 'test',
    logFile: path.join(root, 'backend_debug.log'),
    appHome: root,
  };
}

/** AppPaths for a throwaway data root (already created, with the guest profile dirs). */
export function fixturePaths(root: string = lapFixtureRoot()): AppPaths {
  const paths = new AppPaths(fixtureEnv(root), fixtureLogger);
  paths.init();
  return paths;
}

/** Copies a fixture database into a profile's `DuckDB_data` with a fixed mtime. */
export async function installSession(
  paths: AppPaths,
  profileId: string,
  source: string,
  targetName: string,
  epochSeconds: number,
): Promise<string> {
  const target = path.join(paths.profileDataDir(profileId), targetName);
  await fs.promises.copyFile(source, target);
  const stamp = new Date(epochSeconds * 1000);
  await fs.promises.utimes(target, stamp, stamp);
  return target;
}

// ---------------------------------------------------------------------------------------------
// MAIN_SESSION_SQL - the rule-by-rule scenario. Hand-computed expectations:
//
// GPS Time  = 90 + 0.5*i        (i = 0..320)         -> sessionStart 90, sessionEnd 250
// Lap       = 100, 130, 160, 162, 190, 220           -> boundaries [90, 100, 130, 160, 162, 190, 220]
//   (the resolver's calcStart 130 - 30.25 = 99.75 is rejected: not > firstLapStart + 1)
// Lap Time  = 130/30.25, 160/28.5, 190/0.0, 220/29.75, 250/31.5   (190/0.0 is dropped as <= 0)
// Fuel Level= 33 samples on the GPS axis -> fuelTimes = 90, 95, 100, ... 250 (every 5s)
//
//  lap  start  end   duration  valid  outLap  inPit  fuelUsed  s1    s2    s3     stint  rule proven
//   0    90    100    10.0     false  true    false   0.50     77.0  null  null     1     no Lap Time -> raw duration;
//                                                                                 ts == end counts, ts == start does not
//   1   100     130    30.25   true   false   false   2.50     12.0   8.0  10.25    1     matched lap time; s3 = duration - s2Value
//   2   130     160    28.50   true   false   true    2.50     11.5   7.5   9.50    1     in-pit lap -> stint becomes 2
//   3   160     162    (skipped: 2.0 < 5.0 raw duration)                                     short-interval skip + lap numbering gap
//   4   162     190    28.00   false  true    false   2.00     13.0  null  null     2     out-lap after a pit lap; 0.0 sector2 = absent
//   5   190     220    29.75   true   false   true    2.50     null null null       2     sector2 without sector1 -> all null
//   6   220     250    31.50   true   true    true    0.00     12.5   8.5  10.50    3     fuel refuel clamps to 0; ts == start is in-pit
// ---------------------------------------------------------------------------------------------

export const MAIN_SESSION_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" SELECT 90.0 + x * 0.5 FROM range(321) t(x) ORDER BY x',
  'CREATE TABLE "GPS Latitude" (value DOUBLE)',
  'INSERT INTO "GPS Latitude" SELECT 40.0 + x FROM range(321) t(x) ORDER BY x',
  'CREATE TABLE "GPS Longitude" (value DOUBLE)',
  'INSERT INTO "GPS Longitude" SELECT 20.0 + x FROM range(321) t(x) ORDER BY x',
  'CREATE TABLE "Fuel Level" (value DOUBLE)',
  'INSERT INTO "Fuel Level" SELECT CASE WHEN x < 27 THEN 60.0 - x * 0.5 ELSE 68.0 - (x - 27) * 0.5 END FROM range(33) t(x) ORDER BY x',
  'CREATE TABLE "Lap Dist" (value DOUBLE)',
  'INSERT INTO "Lap Dist" SELECT x * 10.0 FROM range(601) t(x) ORDER BY x',
  'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Lap" VALUES (100.0, 1.0), (130.0, 2.0), (160.0, 3.0), (162.0, 4.0), (190.0, 5.0), (220.0, 6.0)',
  'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Lap Time" VALUES (130.0, 30.25), (160.0, 28.5), (190.0, 0.0), (220.0, 29.75), (250.0, 31.5)',
  'CREATE TABLE "Last Sector1" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Last Sector1" VALUES (99.0, 4.5), (100.0, 77.0), (129.0, 12.0), (131.0, 55.0), (159.0, 11.5), (189.0, 13.0), (249.0, 12.5)',
  'CREATE TABLE "Last Sector2" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Last Sector2" VALUES (129.5, 20.0), (159.5, 19.0), (189.5, 0.0), (219.0, 18.0), (249.5, 21.0), (251.0, 33.0)',
  'CREATE TABLE "In Pits" (ts DOUBLE, value BOOLEAN)',
  'INSERT INTO "In Pits" VALUES (100.0, false), (130.0, false), (150.0, true), (180.0, false), (219.9, true), (220.0, true)',
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Sebring International Raceway')",
  "INSERT INTO metadata VALUES ('TrackLayout', 'Default')",
  "INSERT INTO metadata VALUES ('CarName', 'United Autosports McLaren 720S GT3 Evo')",
  "INSERT INTO metadata VALUES ('CarClass', 'LMGT3')",
  "INSERT INTO metadata VALUES ('DriverName', 'A. Driver')",
  "INSERT INTO metadata VALUES ('SessionTime', '2026-10-25 18:00:00')",
  "INSERT INTO metadata VALUES ('SessionType', 'Race')",
  "INSERT INTO metadata VALUES ('WeatherConditions', 'Light Rain')",
  `INSERT INTO metadata VALUES ('CarSetup', '{"VM_STEER_LOCK":{"stringValue":"520 degrees"},"VM_FUEL_CAPACITY":{"stringValue":"70 litres"},"VM_FRONT_TIRE_COMPOUND":{"maxValue":4},"VM_REAR_TIRE_COMPOUND":{"maxValue":4}}')`,
];

/**
 * BARE_SESSION_SQL - the "import produced an almost empty file" boundary. No metadata table,
 * no sector/pit/fuel/Lap tables at all. GPS Time 0..10, so `LapBoundaryResolver` falls back to
 * a single boundary at the session start and LapService emits exactly one raw-duration lap:
 * { lap: 0, start 0, end 10, duration 10, valid false, outLap true, inPit false, fuel 0,
 *   s1/s2/s3 null, stint 1 }. Every metadata field takes its Java fallback.
 */
export const BARE_SESSION_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" SELECT x * 1.0 FROM range(11) t(x) ORDER BY x',
];

/**
 * FINGERPRINT_SESSION_SQL - `LapService.applyDistanceFingerprint` + empty laps.
 * Sebring / layout 'Default' has an official length of 6019, "Lap Dist" peaks at 3200
 * (ratio 0.53, outside the 0.8..1.2 band), so the nearest declared layout wins: the
 * School Circuit's 3219 - while `layoutKey` stays 'Default'. GPS Time only spans 0..3 and
 * the single boundary interval is therefore < 5s, so `laps` is empty and `trackSectors` too.
 * CarConfig is present, so fuelCapacity comes from it and tyreCompoundMax is forced to 0.
 */
export const FINGERPRINT_SESSION_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" SELECT x * 1.0 FROM range(4) t(x) ORDER BY x',
  'CREATE TABLE "Lap Dist" (value DOUBLE)',
  'INSERT INTO "Lap Dist" SELECT x * 10.0 FROM range(321) t(x) ORDER BY x',
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Sebring International Raceway')",
  "INSERT INTO metadata VALUES ('TrackLayout', 'Default')",
  "INSERT INTO metadata VALUES ('CarName', 'Oreca 07')",
  "INSERT INTO metadata VALUES ('CarClass', 'GTE')",
  `INSERT INTO metadata VALUES ('CarConfig', '{"fuelCapacity": 80.5}')`,
  `INSERT INTO metadata VALUES ('CarSetup', '{"VM_STEER_LOCK":{"stringValue":"480 degrees"}}')`,
];

/**
 * SETUP_FALLBACKS_SESSION_SQL - the setup-JSON reading chain:
 * - no "Lap Dist" table at all -> `scalarDouble` is null and the official length stays 3219;
 * - VM_FUEL_CAPACITY only has `lastSavedStringValue` ("62.5 L" -> 62.5);
 * - VM_FRONT_TIRE_COMPOUND is missing, so the rear entry's maxValue (3) is used;
 * - VM_STEER_LOCK's stringValue is blank -> steeringLock and steeringLockString are both null;
 * - the car name hits the seeded mapping ("oreca" -> Oreca 07 Gibson, lock 480) but the
 *   parsed override is null, so the metadata's steeringLock field stays null.
 */
export const SETUP_FALLBACKS_SESSION_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" SELECT x * 1.0 FROM range(11) t(x) ORDER BY x',
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Sebring International Raceway')",
  "INSERT INTO metadata VALUES ('TrackLayout', 'School Circuit')",
  "INSERT INTO metadata VALUES ('CarName', 'Oreca 07')",
  "INSERT INTO metadata VALUES ('CarClass', 'LMP2')",
  `INSERT INTO metadata VALUES ('CarSetup', '{"VM_FUEL_CAPACITY":{"lastSavedStringValue":"62.5 L","value":0.0},"VM_REAR_TIRE_COMPOUND":{"maxValue":3},"VM_STEER_LOCK":{"stringValue":"   "}}')`,
];

/**
 * UNKNOWN_TRACK_SESSION_SQL - no track match, blank metadata values, malformed setup JSON.
 * LapService keeps Java's fallbacks: commonTrackName = the raw name, aliases [], country '',
 * layoutKey null (blank layout), officialTrackLength null (the fingerprint is skipped
 * without a track), fuelCapacity/tyreCompoundMax 0, steeringLock null.
 */
export const UNKNOWN_TRACK_SESSION_SQL: readonly string[] = [
  'CREATE TABLE "GPS Time" (value DOUBLE)',
  'INSERT INTO "GPS Time" SELECT x * 1.0 FROM range(11) t(x) ORDER BY x',
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Neverland Street Circuit')",
  "INSERT INTO metadata VALUES ('TrackLayout', '   ')",
  "INSERT INTO metadata VALUES ('CarName', '')",
  "INSERT INTO metadata VALUES ('CarClass', '   ')",
  "INSERT INTO metadata VALUES ('DriverName', '   ')",
  "INSERT INTO metadata VALUES ('SessionTime', '   ')",
  "INSERT INTO metadata VALUES ('SessionType', '   ')",
  "INSERT INTO metadata VALUES ('WeatherConditions', '   ')",
  "INSERT INTO metadata VALUES ('CarSetup', 'this is not json {')",
  "INSERT INTO metadata VALUES ('CarConfig', CAST(NULL AS VARCHAR))",
];
