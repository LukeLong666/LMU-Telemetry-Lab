import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { LapExportService, type ExportResult } from '../../src/application/lap-export-service.js';
import { LapService } from '../../src/application/lap-service.js';
import { SetupService } from '../../src/application/setup-service.js';
import { ApiException } from '../../src/api/error.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import { DuckDbConnectionFactory } from '../../src/infra/duckdb/connection.js';
import * as DuckDbReads from '../../src/infra/duckdb/reads.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import {
  BARE_SESSION_SQL,
  MAIN_SESSION_SQL,
  buildSessionDatabase,
  cleanupLapFixtures,
  fixtureLogger,
  fixturePaths,
  installSession,
} from './fixtures.js';
import {
  createFusionFixture,
  makeTempDir,
  type DuckDbFixture,
} from '../helpers/duckdb-fixture.js';

/**
 * LapExportService.java: the ATTACH/CTAS slice. The expectations below are the Java contract:
 * the exported table list, the per-table row counts (the `ts >= start AND ts <= end + 1.0`,
 * sparse-carry and `rowid` ratio windows) and the synthetic `Lap`/`Lap Time`/sector rows.
 */

const factory = new DuckDbConnectionFactory();
const noDiscord = {
  async getThreadAttachments(): Promise<null> {
    return null;
  },
  async downloadFile(): Promise<void> {
    throw new Error('downloadFile must not be reached by these tests');
  },
};

function createService(paths: AppPaths): LapExportService {
  const metadataReader = new MetadataReader(fixtureLogger);
  const sessions = new SessionRepository(paths, noDiscord, fixtureLogger);
  const lapService = new LapService(
    factory,
    metadataReader,
    new TrackRegistry(fixtureLogger),
    new CarCatalog(),
    fixtureLogger,
  );
  const setupService = new SetupService(sessions, factory, metadataReader);
  return new LapExportService(
    sessions,
    lapService,
    setupService,
    new CarCatalog(),
    factory,
    paths,
    fixtureLogger,
  );
}

function query<T>(database: string, read: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  return factory.withConnection(database, (session) => read(session.connection));
}

function num(value: DuckDBValue | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number(value);
}

/** Rows as plain number matrices, so `toEqual` can compare the exported values literally. */
async function numberRows(database: string, sql: string): Promise<number[][]> {
  return query(database, async (connection) => {
    const rows = await DuckDbReads.readRows(connection, sql);
    return rows.map((row) => row.map(num));
  });
}

async function rowCount(database: string, table: string): Promise<number> {
  const rows = await numberRows(database, `SELECT COUNT(*) FROM "${table}"`);
  return rows[0]?.[0] ?? -1;
}

async function exportedTables(database: string): Promise<string[]> {
  return query(database, (connection) => DuckDbReads.tableNames(connection));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function cacheFiles(paths: AppPaths, profileId: string): string[] {
  const dir = paths.profileCacheDir(profileId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/**
 * The 28 fusion tables plus `metadata`: `LapExportService` re-creates every source table whose
 * non-`ts` column list is not empty, so the export must contain exactly these names.
 */
const FUSION_TABLE_NAMES = [
  'ABS',
  'Engine Data',
  'GPS Latitude',
  'GPS Longitude',
  'GPS Speed',
  'GPS Time',
  'Gear',
  'Ground Speed',
  'In Pits',
  'Lap',
  'Lap Dist',
  'Lap Time',
  'RPM',
  'Setup',
  'Steering Pos',
  'Susp Pos',
  'TCCut',
  'Throttle Pos',
  'Throttle Pos Unfiltered',
  'Tyre Loads',
  'TyresCompound',
  'TyresTempCentre',
  'TyresTempLeft',
  'TyresTempRight',
  'Wheel ABS',
  'Wheel Speed',
  'WheelTC',
  'WheelsDetached',
  'metadata',
];

/** Extra tables that pin the remaining Java branches: COPY_WHOLE and the "no value columns" skip. */
const EXPORT_EXTRAS: readonly string[] = [
  'CREATE TABLE channelsList (name VARCHAR)',
  "INSERT INTO channelsList VALUES ('Speed'), ('RPM')",
  'CREATE TABLE "Best LapTime" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Best LapTime" VALUES (130.0, 30.25), (220.0, 29.75)',
  'CREATE TABLE "Best Sector1" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Best Sector1" VALUES (130.0, 11.75)',
  'CREATE TABLE "Best Sector2" (ts DOUBLE, value DOUBLE)',
  'INSERT INTO "Best Sector2" VALUES (130.0, 19.25)',
  'CREATE TABLE "Only Ts" (ts DOUBLE)',
  'INSERT INTO "Only Ts" VALUES (100.0), (130.0)',
];

const lapRoot = fixturePaths();
let fusionDir = '';
let fusion: DuckDbFixture;
let fusionSession = '';
let mainSession = '';
let bareSession = '';

beforeAll(async () => {
  // The fusion session: GPS Time 0..120, Lap events at 30/70, Lap Time 30->25.0 and 70->40.0,
  // so LapService yields lap 0 {0..30, 25}, lap 1 {30..70, 40} and lap 2 {70..120, 50}.
  fusionDir = makeTempDir('lmutl-export-fusion-');
  fusion = await createFusionFixture({ dir: fusionDir, databaseName: 'source.duckdb' });
  fusionSession = await installSession(
    lapRoot,
    'guest',
    fusion.database,
    'fusion-session.duckdb',
    1_700_000_000,
  );

  mainSession = await buildSessionDatabase('export-main-session.duckdb', [
    ...MAIN_SESSION_SQL,
    ...EXPORT_EXTRAS,
  ]);
  await installSession(lapRoot, 'guest', mainSession, 'main-session.duckdb', 1_700_000_001);

  bareSession = await buildSessionDatabase('export-bare-session.duckdb', BARE_SESSION_SQL);
  await installSession(lapRoot, 'guest', bareSession, 'bare-session.duckdb', 1_700_000_002);
}, 300_000);

afterAll(() => {
  fusion?.dispose();
  if (fusionDir !== '') fs.rmSync(fusionDir, { recursive: true, force: true });
  cleanupLapFixtures();
});

describe('LapExportService.export - the sliced lap database', () => {
  let result: ExportResult;
  let exported = '';

  beforeAll(async () => {
    result = await createService(lapRoot).export('guest', 'fusion-session.duckdb', 1, null);
    exported = result.path;
  }, 180_000);

  it('writes the lap into the profile cache dir with the Java file name', () => {
    // TrackLayout 'National Circuit', CarName 'United Autosports' -> seeded McLaren 720S GT3 Evo,
    // no RecordingTime metadata -> the stripped session id, duration 40s -> 0m40s000.
    expect(result.filename).toBe(
      'National-Circuit-McLaren-720S-GT3-Evo-L1-0m40s000_fusion-session.duckdb',
    );
    expect(exported).toBe(path.resolve(lapRoot.profileCacheDir('guest'), result.filename));
    expect(fs.existsSync(exported)).toBe(true);
  });

  it('re-creates every source table, name for name', async () => {
    const sourceTables = await exportedTables(fusionSession);
    expect(sorted(sourceTables)).toEqual(FUSION_TABLE_NAMES);
    expect(await exportedTables(exported)).toEqual(sourceTables);
  });

  it('appends the two export markers to the copied metadata table', async () => {
    const rows = await query(exported, async (connection) => {
      const reader = await DuckDbReads.readRows(connection, 'SELECT key, value FROM metadata ORDER BY key');
      return reader.map((row) => [String(row[0]), row[1] === null ? null : String(row[1])]);
    });
    expect(rows).toEqual([
      ['CarClass', 'LMGT3'],
      ['CarName', 'United Autosports'],
      ['DriverName', null],
      ['ExportedFrom', 'fusion-session.duckdb'],
      ['ExportedLap', '1'],
      ['TrackLayout', 'National Circuit'],
      ['TrackName', 'Silverstone'],
    ]);
  });

  it('replaces Lap / Lap Time with the lap-relative synthetic rows', async () => {
    expect(await numberRows(exported, 'SELECT ts, value FROM "Lap" ORDER BY ts')).toEqual([
      [0, 0],
      [40, 1],
    ]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Lap Time"')).toEqual([[40, 40]]);
  });

  it('slices the timestamped channels onto `ts >= start AND ts <= end + 1.0`, shifted by start', async () => {
    // Gear events 5/12/35/78 -> only 35.0 is inside [30, 71]; ts becomes 35 - 30.
    expect(await numberRows(exported, 'SELECT ts, value FROM "Gear" ORDER BY ts')).toEqual([[5, 5]]);
    // In Pits is not a sparse channel: 30/34/70 all fall inside the window.
    expect(await numberRows(exported, 'SELECT ts, value FROM "In Pits" ORDER BY ts')).toEqual([
      [0, 1],
      [4, 0],
      [40, 1],
    ]);
    // Setup has Throttle/Brake instead of `value`: both columns survive, the NULL stays a NULL.
    expect(await numberRows(exported, 'SELECT ts, "Throttle", "Brake" FROM "Setup" ORDER BY ts')).toEqual([
      [3.5, Number.NaN, 0.2],
      [20.5, 0.9, 0.3],
    ]);
    // Wheel events: only 60.0 is inside the window.
    expect(await numberRows(exported, 'SELECT ts, value1, value4 FROM "Wheel Speed"')).toEqual([[30, 72, 60]]);
    // Outside every window: created, but empty.
    expect(await rowCount(exported, 'Tyre Loads')).toBe(0);
    expect(await rowCount(exported, 'TyresTempLeft')).toBe(0);
  });

  it('carries the last pre-lap value at ts 0 for the sparse channels', async () => {
    // TyresCompound 10.0 -> 2.0 carried in, the 75.0 event is past end + 1.
    expect(await numberRows(exported, 'SELECT ts, value FROM "TyresCompound" ORDER BY ts')).toEqual([[0, 2]]);
    // WheelsDetached has nothing before 30, so only the in-lap event is written.
    expect(await numberRows(exported, 'SELECT ts, value FROM "WheelsDetached" ORDER BY ts')).toEqual([[10, 1]]);
    // Java's carry statement is `SELECT CAST(0.0 AS DOUBLE) AS ts, ... ORDER BY ts DESC LIMIT 1`:
    // the ORDER BY resolves to the *alias* (the constant 0.0), so when several readings sit before
    // the lap all of them tie and any one may be carried. The row count and ts are pinned; the
    // value is one of the pre-lap readings. Same SQL, same behaviour in the Java backend.
    for (const table of ['ABS', 'TCCut'] as const) {
      const rows = await numberRows(exported, `SELECT ts, value FROM "${table}"`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[0]).toBe(0);
      expect([0, 1]).toContain(rows[0]?.[1]);
    }
    expect(
      await numberRows(exported, 'SELECT ts, value1, value2, value3, value4 FROM "Wheel ABS" ORDER BY ts'),
    ).toEqual([
      [0, 1, 0, 0, 0],
      [0.5, 0, 1, 0, 0],
      [20.5, 0, 0, 0, 0],
    ]);
    expect(
      await numberRows(exported, 'SELECT ts, value1, value2, value3, value4 FROM "WheelTC" ORDER BY ts'),
    ).toEqual([
      [0, 0, 0, 0, 0],
      [15.5, 1, 0, 0, 0],
    ]);
  });

  it('windows the frame tables by the rowid ratio, GPS Time relative to the lap start', async () => {
    // GPS Time = 0..120 at 1 Hz: rowid window [MIN(rowid) where value >= 30, MIN(rowid) where
    // value > 70] = 42 rows, values 0.0 .. 41.0 -> the min/max sit inside [0, duration + 1].
    const gps = await numberRows(exported, 'SELECT MIN(value), MAX(value), COUNT(*) FROM "GPS Time"');
    expect(gps).toEqual([[0, 41, 42]]);
    // A 121-row frame table follows the same window; the 61-row RPM table is scaled by 61/121.
    expect(await rowCount(exported, 'Ground Speed')).toBe(42);
    expect(await rowCount(exported, 'Susp Pos')).toBe(42);
    expect(await rowCount(exported, 'RPM')).toBe(21);
    // Lap Dist keeps 42 rows and keeps its 6 m step; the Java offset makes the first sampled
    // value 0, so the span stays (42 - 1) * 6.
    const dist = await numberRows(exported, 'SELECT MIN(value), MAX(value), COUNT(*) FROM "Lap Dist"');
    expect(dist[0]?.[1]).toBeCloseTo(246, 5);
    expect(dist[0]?.[2]).toBe(42);
    // Engine Data keeps both of its columns.
    expect(
      await numberRows(exported, 'SELECT value, "Oil Pressure" FROM "Engine Data" ORDER BY rowid LIMIT 2'),
    ).toEqual([[530, 3], [531, 3]]);
  });

  it('releases the file handle so the export can be renamed immediately', () => {
    const renamed = path.join(path.dirname(exported), 'renamed-lap.duckdb');
    expect(() => fs.renameSync(exported, renamed)).not.toThrow();
    expect(fs.existsSync(renamed)).toBe(true);
    fs.rmSync(renamed, { force: true });
  });
});

describe('LapExportService.export - synthetic sector tables and the whole-copy branch', () => {
  const service = createService(lapRoot);

  it('writes the sector rows of the selected lap and copies metadata/channelsList whole', async () => {
    // lap 1 of the MAIN fixture: start 100, end 130, duration 30.25, s1 12.0, s2 8.0.
    const result = await service.export('guest', 'main-session.duckdb', 1, null);
    const exported = result.path;
    expect(result.filename).toBe('Default-McLaren-720S-GT3-Evo-L1-0m30s250_main-session.duckdb');

    expect(await numberRows(exported, 'SELECT ts, value FROM "Last Sector1"')).toEqual([[12, 12]]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Best Sector1"')).toEqual([[12, 12]]);
    // Sector2 is written as the s1 + s2 total, ts == value.
    expect(await numberRows(exported, 'SELECT ts, value FROM "Last Sector2"')).toEqual([[20, 20]]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Best Sector2"')).toEqual([[20, 20]]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Lap" ORDER BY ts')).toEqual([
      [0, 0],
      [30.25, 1],
    ]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Lap Time"')).toEqual([[30.25, 30.25]]);
    expect(await numberRows(exported, 'SELECT ts, value FROM "Best LapTime"')).toEqual([[30.25, 30.25]]);

    // COPY_WHOLE: straight copies, no window at all.
    const channels = await query(exported, (connection) =>
      DuckDbReads.readRows(connection, 'SELECT name FROM channelsList ORDER BY name'),
    );
    expect(channels.map((row) => String(row[0]))).toEqual(['RPM', 'Speed']);
    const markers = await query(exported, (connection) =>
      DuckDbReads.readRows(connection, "SELECT value FROM metadata WHERE key IN ('ExportedLap', 'ExportedFrom')"),
    );
    expect(markers.map((row) => String(row[0])).sort()).toEqual(['1', 'main-session.duckdb']);

    // The `ts`-only table has no value column, so Java creates nothing for it.
    expect(await exportedTables(exported)).not.toContain('Only Ts');
    fs.rmSync(exported, { force: true });
  }, 180_000);

  it('drops the sector2 tables and keeps the raw sector1 value when the lap has no s2', async () => {
    // lap 0: start 90, end 100, duration 10.0, s1 77.0, s2 null.
    const result = await service.export('guest', 'main-session.duckdb', 0, null);
    const exported = result.path;
    expect(result.filename).toBe('Default-McLaren-720S-GT3-Evo-L0-0m10s000_main-session.duckdb');

    const tables = await exportedTables(exported);
    expect(tables).toContain('Last Sector1');
    expect(tables).toContain('Best Sector1');
    // With s2 == null Java's synthetic sector branch does not fire, so the sector2 tables fall
    // through to the ordinary event window slice - created, but empty for this lap.
    expect(tables).toContain('Last Sector2');
    expect(tables).toContain('Best Sector2');
    expect(await rowCount(exported, 'Last Sector2')).toBe(0);
    expect(await rowCount(exported, 'Best Sector2')).toBe(0);
    // Java writes the sector value itself, un-shifted.
    expect(await numberRows(exported, 'SELECT ts, value FROM "Last Sector1"')).toEqual([[77, 77]]);
    // GPS Time 90 + 0.5i: the rowid window [0, MIN(rowid) where value > 100] = rows 0..21.
    expect(await numberRows(exported, 'SELECT MIN(value), MAX(value), COUNT(*) FROM "GPS Time"')).toEqual([
      [0, 10.5, 22],
    ]);
    // Fuel Level has 33 of 321 rows -> ratio 0.1028 -> rowid window [0, trunc(21 * ratio)] = 2.
    expect(await rowCount(exported, 'Fuel Level')).toBe(3);
    // Lap Dist has 601 of 321 rows -> ratio 1.872 -> window [0, 39]; offset comes from rowid 0.
    expect(await numberRows(exported, 'SELECT MIN(value), MAX(value), COUNT(*) FROM "Lap Dist"')).toEqual([
      [0, 390, 40],
    ]);
    fs.rmSync(exported, { force: true });
  }, 180_000);
});

describe('LapExportService.export - custom car model, re-export and failures', () => {
  const service = createService(lapRoot);

  it('uses the custom model in the file name and rewrites CarName in the export', async () => {
    const result = await service.export('guest', 'fusion-session.duckdb', 0, 'Custom Car Name');
    expect(result.filename).toBe('National-Circuit-Custom-Car-Name-L0-0m25s000_fusion-session.duckdb');

    const carName = await query(result.path, (connection) =>
      DuckDbReads.readRows(connection, "SELECT value FROM metadata WHERE key = 'CarName'"),
    );
    expect(carName).toEqual([['Custom Car Name']]);

    const renamed = path.join(path.dirname(result.path), 'custom-renamed.duckdb');
    expect(() => fs.renameSync(result.path, renamed)).not.toThrow();
    fs.rmSync(renamed, { force: true });
  }, 180_000);

  it('overwrites an existing export for the same lap instead of failing', async () => {
    const first = await service.export('guest', 'fusion-session.duckdb', 2, null);
    const firstSize = fs.statSync(first.path).size;
    const second = await service.export('guest', 'fusion-session.duckdb', 2, null);
    expect(second.path).toBe(first.path);
    expect(fs.statSync(second.path).size).toBe(firstSize);
    // Java does `Files.deleteIfExists(output)` first: one file per lap, no `.wal` leftovers.
    expect(cacheFiles(lapRoot, 'guest').filter((file) => file === second.filename)).toHaveLength(1);
    expect(cacheFiles(lapRoot, 'guest').filter((file) => file.endsWith('.wal'))).toEqual([]);
    expect(await rowCount(second.path, 'GPS Time')).toBe(51);
    fs.rmSync(second.path, { force: true });
  }, 180_000);

  it('fails with 404 when the lap number is not in the session', async () => {
    const before = cacheFiles(lapRoot, 'guest');
    await expect(service.export('guest', 'fusion-session.duckdb', 99, null)).rejects.toMatchObject({
      status: 404,
      message: 'Lap 99 not found',
    });
    expect(cacheFiles(lapRoot, 'guest')).toEqual(before);
  });

  it('surfaces the session resolution errors untouched', async () => {
    await expect(service.export('guest', 'missing-session.duckdb', 0, null)).rejects.toBeInstanceOf(
      ApiException,
    );
    await expect(service.export('guest', '../secrets.duckdb', 0, null)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('reports a 500 and leaves no partial file when the slicing fails', async () => {
    // The bare fixture has no `metadata` table, so the copy markers are the failing statement.
    const error = await service
      .export('guest', 'bare-session.duckdb', 0, null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect((error as ApiException).message).toMatch(/^Lap export failed: /);

    const leftovers = cacheFiles(lapRoot, 'guest').filter(
      (file) => file.endsWith('.duckdb') || file.endsWith('.wal'),
    );
    expect(leftovers).toEqual([]);
  }, 180_000);
});

describe('LapExportService file-name sanitisation', () => {
  /** A session whose metadata carries the characters the Java file name builder filters. */
  async function weirdLayoutSession(fileName: string, recordingTime: string): Promise<string> {
    const source = await buildSessionDatabase(fileName, [
      'CREATE TABLE "GPS Time" (value DOUBLE)',
      'INSERT INTO "GPS Time" SELECT CAST(x AS DOUBLE) FROM range(121) t(x) ORDER BY x',
      'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap" VALUES (30.0, 2.0)',
      'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap Time" VALUES (30.0, 25.0)',
      'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
      "INSERT INTO metadata VALUES ('TrackName', 'Le Castrique')",
      "INSERT INTO metadata VALUES ('TrackLayout', 'Ricard / 1:2 <A>|B*C?D')",
      "INSERT INTO metadata VALUES ('CarName', 'Oreca 07')",
      "INSERT INTO metadata VALUES ('CarClass', 'LMP2')",
      `INSERT INTO metadata VALUES ('RecordingTime', '${recordingTime}')`,
    ]);
    return installSession(lapRoot, 'guest', source, fileName, 1_700_000_003);
  }

  it('sanitises the layout and car model but writes RecordingTime raw', async () => {
    await weirdLayoutSession('weird-session.duckdb', 'Session 42');
    const result = await createService(lapRoot).export('guest', 'weird-session.duckdb', 0, null);
    // ' ' -> '-' first, then [\\/*?:"<>|] dropped: 'Ricard / 1:2 <A>|B*C?D' -> 'Ricard--12-ABCD'.
    // RecordingTime is concatenated untouched, spaces and all - the Java rule.
    expect(result.filename).toBe('Ricard--12-ABCD-Oreca-07-Gibson-L0-0m25s000_Session 42.duckdb');
    expect(fs.existsSync(result.path)).toBe(true);
    fs.rmSync(result.path, { force: true });
  }, 180_000);

  it('fails as a 500 when the raw RecordingTime is not a legal Windows file name', async () => {
    await weirdLayoutSession('colon-session.duckdb', '2026-10-25 18:00:00');
    const error = await createService(lapRoot)
      .export('guest', 'colon-session.duckdb', 0, null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect(cacheFiles(lapRoot, 'guest').filter((file) => file.endsWith('.duckdb'))).toEqual([]);
  }, 180_000);
});
