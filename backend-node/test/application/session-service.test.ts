/**
 * Tests for the ported SessionService (`src/application/session-service.ts`).
 *
 * Focus, in the order the Java rules are written:
 * - best-lap selection: one synthetic session per tier of SessionService.java:71-84, plus the
 *   `duration > 0` guard, which real lap data cannot produce (LapService skips intervals under
 *   5s and the boundary resolver drops lap times <= 0), so that guard is proven through a stub.
 * - the row shape of `/sessions`, including which keys disappear for the NON_NULL fields.
 * - the scan cache: mtime+size invalidation, the profile dimension, the failed-scan
 *   non-caching, and the invalidation done by upload / rename / delete.
 *
 * `test/application/fixtures.ts` (written for LapService) supplies the temp root, the app
 * paths, the profile installer and the shared MAIN/BARE/UNKNOWN session databases.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LapService, type LapCacheIdentity } from '../../src/application/lap-service.js';
import { SessionService } from '../../src/application/session-service.js';
import type { SessionResolver } from '../../src/application/setup-service.js';
import { ApiException } from '../../src/api/error.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import {
  DuckDbConnectionFactory,
  type DuckDbSession,
} from '../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import type {
  DiscordAttachmentMap,
  DiscordSessionGateway,
  IncomingFile,
} from '../../src/infra/fs/session-repository.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import type { LapInfo, LapsResponse, SessionInfo, SessionMetadata } from '../../src/domain/types.js';
import {
  BARE_SESSION_SQL,
  MAIN_SESSION_SQL,
  UNKNOWN_TRACK_SESSION_SQL,
  buildSessionDatabase,
  cleanupLapFixtures,
  fixtureLogger,
  fixturePaths,
  installSession,
  lapFixtureRoot,
} from './fixtures.js';

/** `/sessions` never downloads anything; the repository only needs the port to exist. */
class NoDiscordGateway implements DiscordSessionGateway {
  async getThreadAttachments(): Promise<DiscordAttachmentMap | null> {
    return null;
  }
  async downloadFile(): Promise<void> {
    /* unused */
  }
}

/** Counts DuckDB opens so "the second list touches no database" is observable. */
class CountingConnectionFactory extends DuckDbConnectionFactory {
  opens = 0;

  override async withConnection<T>(
    database: string,
    read: (session: DuckDbSession) => Promise<T>,
  ): Promise<T> {
    this.opens += 1;
    return super.withConnection(database, read);
  }
}

interface Harness {
  readonly service: SessionService;
  readonly lapService: LapService;
  readonly repository: SessionRepository;
  readonly connections: CountingConnectionFactory;
}

/** SessionService.java:36-42 - repository, lap service, registry (+ the logger Java holds static). */
function createHarness(): Harness {
  const connections = new CountingConnectionFactory();
  const lapService = new LapService(
    connections,
    new MetadataReader(fixtureLogger),
    new TrackRegistry(fixtureLogger),
    new CarCatalog(),
    fixtureLogger,
  );
  const repository = new SessionRepository(paths, new NoDiscordGateway(), fixtureLogger);
  const service = new SessionService(
    repository,
    lapService,
    new TrackRegistry(fixtureLogger),
    fixtureLogger,
  );
  return { service, lapService, repository, connections };
}

// ---------------------------------------------------------------------------------------------
// Best-lap fixtures. Each block documents the laps LapService reports and the expected winner,
// so the tiers of SessionService.java:71-84 are each pinned by one real session file.
// ---------------------------------------------------------------------------------------------

interface LapFixture {
  readonly gpsFrom: number;
  readonly gpsTo: number;
  readonly lapEvents: ReadonlyArray<readonly [number, number]>;
  readonly lapTimes: ReadonlyArray<readonly [number, number]>;
  readonly inPitAt: readonly number[];
}

const CAR_METADATA: readonly string[] = [
  'CREATE TABLE metadata (key VARCHAR, value VARCHAR)',
  "INSERT INTO metadata VALUES ('TrackName', 'Sebring International Raceway')",
  "INSERT INTO metadata VALUES ('TrackLayout', 'Default')",
  "INSERT INTO metadata VALUES ('CarName', 'United Autosports McLaren 720S GT3 Evo')",
  "INSERT INTO metadata VALUES ('CarClass', 'LMGT3')",
  "INSERT INTO metadata VALUES ('DriverName', 'A. Driver')",
  "INSERT INTO metadata VALUES ('SessionTime', '2026-10-25 18:00:00')",
  "INSERT INTO metadata VALUES ('SessionType', 'Qualify')",
  "INSERT INTO metadata VALUES ('WeatherConditions', 'Light Rain')",
];

function sessionStatements(fixture: LapFixture): string[] {
  const statements: string[] = [
    'CREATE TABLE "GPS Time" (value DOUBLE)',
    `INSERT INTO "GPS Time" SELECT ${fixture.gpsFrom}.0 + x FROM range(${fixture.gpsTo - fixture.gpsFrom + 1}) t(x) ORDER BY x`,
    'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
    `INSERT INTO "Lap" VALUES ${fixture.lapEvents.map(([ts, value]) => `(${ts}.0, ${value}.0)`).join(', ')}`,
    'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
    `INSERT INTO "Lap Time" VALUES ${fixture.lapTimes.map(([ts, value]) => `(${ts}.0, ${value})`).join(', ')}`,
  ];
  if (fixture.inPitAt.length > 0) {
    statements.push('CREATE TABLE "In Pits" (ts DOUBLE, value BOOLEAN)');
    statements.push(
      `INSERT INTO "In Pits" VALUES ${fixture.inPitAt.map((ts) => `(${ts}.0, true)`).join(', ')}`,
    );
  }
  statements.push(...CAR_METADATA);
  return statements;
}

/**
 * Tier 1 - "valid laps only, out-laps excluded, then the minimum".
 * boundaries [100, 125, 157, 185], sessionEnd 215:
 *   lap 0  100->125  25.00 valid   OUT-LAP (first boundary) -> excluded although it is fastest
 *   lap 1  125->157  32.00 valid   qualifies
 *   lap 2  157->185  28.00 invalid (no Lap Time event at 185) -> excluded, although it is fastest
 *   lap 3  185->215  30.50 valid   qualifies -> winner, bestLapValid true
 */
const BEST_VALID: LapFixture = {
  gpsFrom: 100,
  gpsTo: 215,
  lapEvents: [
    [100, 1],
    [125, 2],
    [157, 3],
    [185, 4],
  ],
  lapTimes: [
    [125, 25.0],
    [157, 32.0],
    [215, 30.5],
  ],
  inPitAt: [],
};

/**
 * Tier 2 - nothing is valid, so the second pass (same conditions minus validity) decides and
 * bestLapValid comes back false. The only Lap Time reads 0.0, which the boundary resolver drops.
 *   lap 0  100->115  15.00 invalid OUT-LAP (fastest of all, still excluded)
 *   lap 1  115->160  45.00 invalid qualifies
 *   lap 2  160->190  30.00 invalid qualifies -> winner, bestLapValid false
 */
const BEST_INVALID: LapFixture = {
  gpsFrom: 100,
  gpsTo: 190,
  lapEvents: [
    [100, 1],
    [115, 2],
    [160, 3],
  ],
  lapTimes: [[115, 0.0]],
  inPitAt: [],
};

/**
 * The single-lap exception (line 71): an exported one-lap file flags its only lap as an
 * out-lap, and `(!isOutLap || singleLap)` must still let it win. Lap Time 30.0 at 130 puts the
 * derived session start exactly on the recorded boundary, so no extra boundary is added and the
 * session really holds one lap at index 0: 100->130, 30.00, valid, out-lap.
 */
const BEST_SINGLE_LAP: LapFixture = {
  gpsFrom: 100,
  gpsTo: 130,
  lapEvents: [[100, 1]],
  lapTimes: [[130, 30.0]],
  inPitAt: [],
};

/**
 * No best lap at all: lap 0 is an out-lap because it is the first boundary, and the following
 * ones are out-laps because the lap before them was in the pits. `singleLap` is false, so both
 * passes end up empty and NEITHER key is emitted.
 */
const BEST_NONE: LapFixture = {
  gpsFrom: 100,
  gpsTo: 190,
  lapEvents: [
    [100, 1],
    [130, 2],
    [160, 3],
  ],
  lapTimes: [[130, 30.0]],
  inPitAt: [100, 130, 160],
};

let paths: AppPaths;
let bestValidFile = '';
let bestInvalidFile = '';
let bestSingleLapFile = '';
let bestNoneFile = '';
let mainFile = '';
let bareFile = '';
let unknownTrackFile = '';
/** A plain text file used by the stubbed-lap-service tests; never opened by DuckDB. */
let stubFile = '';

beforeAll(async () => {
  paths = fixturePaths();
  bestValidFile = await buildSessionDatabase('src-best-valid.duckdb', sessionStatements(BEST_VALID));
  bestInvalidFile = await buildSessionDatabase(
    'src-best-invalid.duckdb',
    sessionStatements(BEST_INVALID),
  );
  bestSingleLapFile = await buildSessionDatabase(
    'src-best-single-lap.duckdb',
    sessionStatements(BEST_SINGLE_LAP),
  );
  bestNoneFile = await buildSessionDatabase('src-best-none.duckdb', sessionStatements(BEST_NONE));
  mainFile = await buildSessionDatabase('src-main.duckdb', MAIN_SESSION_SQL);
  bareFile = await buildSessionDatabase('src-bare.duckdb', BARE_SESSION_SQL);
  unknownTrackFile = await buildSessionDatabase('src-unknown.duckdb', UNKNOWN_TRACK_SESSION_SQL);
  stubFile = path.join(lapFixtureRoot(), 'stub-session.duckdb');
  await fs.promises.writeFile(stubFile, 'placeholder for the stubbed lap service tests');
}, 240_000);

afterAll(() => {
  cleanupLapFixtures();
});

/** Copies a source database into a fresh profile under `fileName` with a fixed mtime. */
async function install(
  profile: string,
  source: string,
  fileName: string,
  epochSeconds = 1_700_000_000,
): Promise<string> {
  paths.ensureProfileDirs(profile);
  return installSession(paths, profile, source, fileName, epochSeconds);
}

/** The single row of a one-file profile, as `/sessions` would return it. */
async function onlyRow(profile: string, source: string, fileName: string): Promise<SessionInfo> {
  await install(profile, source, fileName, 1_700_000_500);
  const { service } = createHarness();
  const rows = await service.list(profile);
  expect(rows).toHaveLength(1);
  return rows[0];
}

function emittedKeys(row: SessionInfo): string[] {
  return Object.keys(JSON.parse(JSON.stringify(row)));
}

describe('SessionService best-lap selection', () => {
  it('tier 1: picks the fastest valid lap and skips the faster out-lap', async () => {
    const row = await onlyRow('bl-valid', bestValidFile, 'valid.duckdb');

    // tier 1 keeps laps 1 (32.00) and 3 (30.50); lap 0's 25.00 is an out-lap and lap 2's 28.00
    // is invalid, so neither may win even though both are quicker.
    expect(row.bestLapTime).toBe(30.5);
    expect(row.bestLapValid).toBe(true);
  });

  it('tier 2: falls back to the fastest invalid lap and marks it invalid', async () => {
    const row = await onlyRow('bl-invalid', bestInvalidFile, 'invalid.duckdb');

    expect(row.bestLapTime).toBe(30);
    expect(row.bestLapValid).toBe(false);
  });

  it('tier 3: lets a single-lap session win although its only lap is an out-lap', async () => {
    const row = await onlyRow('bl-single', bestSingleLapFile, 'single.duckdb');

    expect(row.bestLapTime).toBe(30);
    expect(row.bestLapValid).toBe(true);
  });

  it('tier 4: omits both keys when every lap is an out-lap', async () => {
    const row = await onlyRow('bl-none', bestNoneFile, 'none.duckdb');

    expect(row.bestLapTime).toBeUndefined();
    expect(row.bestLapValid).toBeUndefined();
    expect(emittedKeys(row)).not.toContain('bestLapTime');
    expect(emittedKeys(row)).not.toContain('bestLapValid');
  });

  it('applies the single-lap exception to the invalid fallback as well', async () => {
    // BARE_SESSION_SQL holds one raw-duration lap: invalid AND an out-lap.
    const row = await onlyRow('bl-bare', bareFile, 'bare.duckdb');

    expect(row.bestLapTime).toBe(10);
    expect(row.bestLapValid).toBe(false);
  });

  it('reproduces the rule chain on the shared MAIN session', async () => {
    const row = await onlyRow('bl-main', mainFile, 'main.duckdb');

    // valid non-out laps are 30.25 / 28.50 / 29.75; the 28.00 lap is invalid and the 10.00 and
    // 31.50 laps are out-laps, so the quickest qualifying one wins.
    expect(row.bestLapTime).toBe(28.5);
    expect(row.bestLapValid).toBe(true);
  });

  it('drops candidates whose duration is not positive', async () => {
    // `duration > 0` cannot be produced by LapService itself, so it is proven through a stub
    // header: a lone zero-duration lap yields no best lap at all.
    const zero = await stubRow([stubLap({ duration: 0 })]);
    expect(zero.bestLapTime).toBeUndefined();
    expect(zero.bestLapValid).toBeUndefined();

    // NaN and negative durations fail the same guard; the positive lap still wins.
    const mixed = await stubRow([
      stubLap({ duration: Number.NaN }),
      stubLap({ lap: 1, duration: -2, isOutLap: false }),
      stubLap({ lap: 2, duration: 26.75, isOutLap: false }),
    ]);
    expect(mixed.bestLapTime).toBe(26.75);
    expect(mixed.bestLapValid).toBe(true);
  });

  it('excludes out-laps from the invalid fallback in a multi-lap session', async () => {
    // Two out-laps (lap 0 by position, lap 1 flagged) and no valid lap: only lap 2 may qualify.
    const row = await stubRow([
      stubLap({ lap: 0, duration: 20, isValid: false }),
      stubLap({ lap: 1, duration: 21, isValid: false, isOutLap: true }),
      stubLap({ lap: 2, duration: 40, isValid: false, isOutLap: false }),
    ]);
    expect(row.bestLapTime).toBe(40);
    expect(row.bestLapValid).toBe(false);
  });

  it('keeps the first minimum when two laps tie', async () => {
    // Java's Stream.min keeps the first element of a tie; a `<` comparison in one pass does too.
    const row = await stubRow([
      stubLap({ lap: 1, duration: 27.4, isOutLap: false }),
      stubLap({ lap: 2, duration: 27.4, isOutLap: false }),
      stubLap({ lap: 3, duration: 27.4, isOutLap: false }),
    ]);
    expect(row.bestLapTime).toBe(27.4);
  });

  it('passes the profile and session identity to LapService', async () => {
    const identities: LapCacheIdentity[] = [];
    const service = stubbedService([stubLap({ duration: 31.25, isOutLap: false })], identities);

    const row = await service.scan(stubFile, 'p-identity');
    expect(row.bestLapTime).toBe(31.25);
    // the identity is what makes the scan cache and the /laps header cache agree.
    expect(identities).toEqual([{ profileId: 'p-identity', sessionId: 'stub-session.duckdb' }]);

    await service.scan(stubFile);
    expect(identities).toEqual([
      { profileId: 'p-identity', sessionId: 'stub-session.duckdb' },
      { profileId: 'guest', sessionId: 'stub-session.duckdb' },
    ]);
  });
});

describe('SessionService.list row shape', () => {
  it('builds every SessionInfo field from the header and the registry', async () => {
    const target = await install('shape', bestValidFile, 'race-one.duckdb');
    const { service } = createHarness();

    const rows = await service.list('shape');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'race-one.duckdb',
      name: 'race-one',
      created: 1_700_000_000,
      size: (await fs.promises.stat(target)).size,
      trackName: 'Sebring International Raceway',
      trackLayout: 'Default',
      layoutKey: 'Default',
      commonTrackName: 'Sebring International Raceway',
      displayName: 'Sebring',
      trackAliases: ['Sebring'],
      carModel: 'McLaren 720S GT3 Evo',
      carClass: 'LMGT3',
      rawCarName: 'United Autosports McLaren 720S GT3 Evo',
      country: 'United States',
      officialTrackLength: 6019,
      driverName: 'A. Driver',
      bestLapTime: 30.5,
      bestLapValid: true,
    });
  });

  it('emits the keys in the Java record order', async () => {
    await install('order', bestValidFile, 'ordered.duckdb');
    const { service } = createHarness();

    const [row] = await service.list('order');
    expect(emittedKeys(row)).toEqual([
      'id',
      'name',
      'created',
      'size',
      'trackName',
      'trackLayout',
      'layoutKey',
      'commonTrackName',
      'displayName',
      'trackAliases',
      'carModel',
      'carClass',
      'rawCarName',
      'country',
      'officialTrackLength',
      'driverName',
      'bestLapTime',
      'bestLapValid',
    ]);
  });

  it('omits the registry fields and the blank metadata strings of an unmatched track', async () => {
    const row = await onlyRow('unknown-profile', unknownTrackFile, 'unknown.duckdb');

    expect(row).toMatchObject({
      id: 'unknown.duckdb',
      name: 'unknown',
      trackName: 'Neverland Street Circuit',
      carModel: 'Unknown Car',
      carClass: 'Unknown Class',
      rawCarName: 'Unknown Car',
      driverName: 'Unknown Driver',
      // one invalid out-lap, rescued by the single-lap exception.
      bestLapTime: 10,
      bestLapValid: false,
    });
    // SessionService.java:87 gates the five registry-derived fields on the lookup, and every
    // emptyToNull field is dropped instead of being sent as null.
    const emitted = emittedKeys(row);
    expect(emitted).not.toContain('layoutKey');
    expect(emitted).not.toContain('commonTrackName');
    expect(emitted).not.toContain('displayName');
    expect(emitted).not.toContain('trackAliases');
    expect(emitted).not.toContain('country');
    expect(emitted).not.toContain('officialTrackLength');
    expect(emitted).not.toContain('trackLayout');
  });

  it('keeps the file facts and nothing else for a session that cannot be opened', async () => {
    const profile = 'broken';
    await install(profile, bestValidFile, 'healthy.duckdb', 1_700_000_600);
    const broken = path.join(paths.profileDataDir(profile), 'broken.duckdb');
    await fs.promises.writeFile(broken, 'this is not a database');
    await fs.promises.utimes(broken, new Date(1_700_000_700_000), new Date(1_700_000_700_000));

    const { service } = createHarness();
    const rows = await service.list(profile);

    // Java's catch-all keeps the row in the list (SessionService.java:111-115), so a single
    // corrupt file never costs the frontend a session and never turns the page into a 500.
    expect(rows.map((row) => row.id)).toEqual(['broken.duckdb', 'healthy.duckdb']);
    const brokenRow = rows[0];
    expect(emittedKeys(brokenRow)).toEqual(['id', 'name', 'created', 'size']);
    expect(brokenRow.created).toBe(1_700_000_700);
    expect(brokenRow.size).toBe((await fs.promises.stat(broken)).size);
    expect(brokenRow.trackName).toBeUndefined();
    // the healthy session is untouched by its neighbour's failure.
    expect(rows[1].bestLapTime).toBe(30.5);
  });

  it('follows the mtime-descending order of SessionRepository.listFiles', async () => {
    const profile = 'ordering';
    await install(profile, bestValidFile, 'valid.duckdb', 1_700_000_400);
    await install(profile, bestInvalidFile, 'invalid.duckdb', 1_700_000_300);
    await install(profile, bestSingleLapFile, 'single.duckdb', 1_700_000_200);
    await install(profile, bestNoneFile, 'none.duckdb', 1_700_000_100);
    const { service } = createHarness();

    const rows = await service.list(profile);
    expect(rows.map((row) => row.id)).toEqual([
      'valid.duckdb',
      'invalid.duckdb',
      'single.duckdb',
      'none.duckdb',
    ]);
    expect(rows.map((row) => row.bestLapTime)).toEqual([30.5, 30, 30, undefined]);
  });

  it('treats a blank or missing profile as guest and an unknown one as empty', async () => {
    const profile = 'guest';
    await install(profile, bestValidFile, 'valid.duckdb', 1_700_000_400);
    await install(profile, bestNoneFile, 'none.duckdb', 1_700_000_100);
    const { service } = createHarness();

    const asGuest = await service.list('guest');
    expect((await service.list('   ')).map((row) => row.id)).toEqual(asGuest.map((row) => row.id));
    expect((await service.list(null)).map((row) => row.id)).toEqual(asGuest.map((row) => row.id));
    expect(await service.list('nobody')).toEqual([]);
  });
});

describe('SessionService scan cache', () => {
  it('serves a repeated list without opening any database', async () => {
    const profile = 'cache-hit';
    await install(profile, bestValidFile, 'valid.duckdb', 1_700_000_400);
    await install(profile, bestInvalidFile, 'invalid.duckdb', 1_700_000_300);
    await install(profile, bestSingleLapFile, 'single.duckdb', 1_700_000_200);
    await install(profile, bestNoneFile, 'none.duckdb', 1_700_000_100);
    const { service, connections } = createHarness();

    const first = await service.list(profile);
    expect(connections.opens).toBe(4);

    const second = await service.list(profile);
    expect(connections.opens).toBe(4);
    // Java hands the cached SessionInfo instance straight back, so identity is preserved too.
    expect(second).toEqual(first);
    expect(second[0]).toBe(first[0]);
  });

  it('shares one header cache entry with the /laps route identity', async () => {
    const profile = 'cache-shared';
    const target = await install(profile, bestValidFile, 'shared.duckdb');
    const { service, lapService, connections } = createHarness();

    await service.list(profile);
    expect(connections.opens).toBe(1);

    // scan() passes {profileId, sessionId} - exactly what the /laps route can rebuild for a
    // session id taken from this very list, so the second reader hits the same entry.
    await lapService.header(target, { profileId: profile, sessionId: 'shared.duckdb' });
    expect(connections.opens).toBe(1);

    // ReferenceLapService keeps Java's path-only identity, which is a different entry.
    await lapService.header(target);
    expect(connections.opens).toBe(2);
  });

  it('keys the scan cache on the profile as well as the resolved path', async () => {
    const file = await install('cache-profile', bestValidFile, 'same-name.duckdb');
    const { service, connections } = createHarness();

    const asAlpha = await service.scan(file, 'alpha');
    const asAlphaAgain = await service.scan(file, 'alpha');
    expect(connections.opens).toBe(1);
    expect(asAlphaAgain).toBe(asAlpha);

    const asBeta = await service.scan(file, 'beta');
    expect(connections.opens).toBe(2);
    expect(asBeta).not.toBe(asAlpha);
    // the profile is a cache/identity dimension only; the row itself is purely file-derived.
    expect(asBeta).toEqual(asAlpha);

    // a missing profile id falls back to "guest", like list() does.
    const asGuest = await service.scan(file);
    expect(connections.opens).toBe(3);
    expect(asGuest).toEqual(asAlpha);
  });

  it('drops the entry when the file changes', async () => {
    const profile = 'cache-mtime';
    const target = await install(profile, bestValidFile, 'touched.duckdb', 1_700_000_000);
    const { service, connections } = createHarness();

    const before = await service.list(profile);
    expect(connections.opens).toBe(1);

    const future = new Date(1_700_000_000_000 + 60_000);
    await fs.promises.utimes(target, future, future);
    const after = await service.list(profile);
    expect(connections.opens).toBe(2);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].created).toBe(1_700_000_060);

    await service.list(profile);
    expect(connections.opens).toBe(2);

    // a size change invalidates as well, even with the mtime pushed back to the old value.
    await fs.promises.appendFile(target, 'x');
    await fs.promises.utimes(target, new Date(1_700_000_060_000), new Date(1_700_000_060_000));
    await service.list(profile);
    expect(connections.opens).toBe(3);
  });

  it('does not cache a failed scan', async () => {
    const profile = 'cache-broken';
    await install(profile, bestValidFile, 'healthy.duckdb', 1_700_000_000);
    const broken = path.join(paths.profileDataDir(profile), 'broken.duckdb');
    await fs.promises.writeFile(broken, 'not a database');

    const { service, connections } = createHarness();
    await service.list(profile);
    expect(connections.opens).toBe(2);

    // the healthy row is cached, the broken one is retried on every request - as in Java, where
    // only a successful scan is stored.
    await service.list(profile);
    expect(connections.opens).toBe(3);
    await service.list(profile);
    expect(connections.opens).toBe(4);
  });

  it('invalidates the scan cache on rename', async () => {
    const profile = 'cache-rename';
    await install(profile, bestValidFile, 'first.duckdb', 1_700_000_000);
    await install(profile, bestInvalidFile, 'second.duckdb', 1_700_000_001);
    const { service, lapService, connections } = createHarness();
    const clearHeader = vi.spyOn(lapService, 'clearCache');

    const before = await service.list(profile);
    expect(connections.opens).toBe(2);
    const again = await service.list(profile);
    expect(again[0]).toBe(before[0]);
    expect(connections.opens).toBe(2);

    expect(await service.rename(profile, 'first.duckdb', 'renamed')).toBe('renamed.duckdb');
    expect(clearHeader).toHaveBeenCalledTimes(1);

    const rows = await service.list(profile);
    // both rows are re-read: the whole map is dropped, not just the renamed entry.
    expect(connections.opens).toBe(4);
    expect(rows.map((row) => row.id)).toEqual(['second.duckdb', 'renamed.duckdb']);
    expect(rows[1].bestLapTime).toBe(30.5);
    clearHeader.mockRestore();
  });

  it('invalidates the scan cache on delete', async () => {
    const profile = 'cache-delete';
    await install(profile, bestValidFile, 'first.duckdb', 1_700_000_000);
    await install(profile, bestInvalidFile, 'second.duckdb', 1_700_000_001);
    const { service, lapService, connections } = createHarness();
    const clearHeader = vi.spyOn(lapService, 'clearCache');

    await service.list(profile);
    expect(connections.opens).toBe(2);

    await service.delete(profile, 'first.duckdb');
    expect(clearHeader).toHaveBeenCalledTimes(1);

    const rows = await service.list(profile);
    expect(rows.map((row) => row.id)).toEqual(['second.duckdb']);
    expect(connections.opens).toBe(3);
    clearHeader.mockRestore();
  });

  it('drops the LapService header cache too, not only its own map', async () => {
    const profile = 'cache-lap-header';
    const target = await install(profile, bestValidFile, 'first.duckdb', 1_700_000_000);
    const { service, lapService, connections } = createHarness();

    await service.list(profile);
    expect(connections.opens).toBe(1);

    const identity = { profileId: profile, sessionId: 'first.duckdb' };
    await lapService.header(target, identity);
    expect(connections.opens).toBe(1);

    await service.upload(profile, await incomingFile(bestSingleLapFile, 'second.duckdb'));
    // the path is unchanged, so this only opens the database if LapService's cache was cleared.
    await lapService.header(target, identity);
    expect(connections.opens).toBe(2);

    const rows = await service.list(profile);
    expect(rows.map((row) => row.id)).toEqual(['second.duckdb', 'first.duckdb']);
    // first.duckdb was just re-warmed by the direct header() call above, so only the new upload
    // needs a database open.
    expect(connections.opens).toBe(3);
  });

  it('leaves the caches alone when upload fails', async () => {
    const profile = 'cache-upload-fails';
    await install(profile, bestValidFile, 'first.duckdb', 1_700_000_000);
    const { service, lapService, connections } = createHarness();
    const clearHeader = vi.spyOn(lapService, 'clearCache');

    await service.list(profile);
    expect(connections.opens).toBe(1);

    // the repository rejects a missing part with 400 before SessionService can clear anything.
    await expect(service.upload(profile, null)).rejects.toThrow(/File is required/);
    await expect(service.upload(profile, null)).rejects.toBeInstanceOf(ApiException);
    expect(clearHeader).not.toHaveBeenCalled();

    await service.list(profile);
    expect(connections.opens).toBe(1);
    clearHeader.mockRestore();
  });

  it('surfaces the repository errors of rename and delete unchanged', async () => {
    const profile = 'rename-errors';
    await install(profile, bestValidFile, 'first.duckdb', 1_700_000_000);
    await install(profile, bestInvalidFile, 'second.duckdb', 1_700_000_001);
    const { service, lapService, connections } = createHarness();
    const clearHeader = vi.spyOn(lapService, 'clearCache');

    await service.list(profile);
    expect(connections.opens).toBe(2);

    await expect(service.rename(profile, 'missing.duckdb', 'whoever')).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.rename(profile, 'first.duckdb', 'second')).rejects.toMatchObject({
      status: 400,
      message: 'File with new name already exists',
    });
    await expect(service.rename(profile, 'first.duckdb', '   ')).rejects.toMatchObject({
      status: 400,
      message: 'New name is required',
    });
    await expect(service.delete(profile, 'missing.duckdb')).rejects.toMatchObject({ status: 400 });
    // a rejected mutation never reaches clearCaches(), exactly like Java's throw-first path.
    expect(clearHeader).not.toHaveBeenCalled();
    expect(connections.opens).toBe(2);
    clearHeader.mockRestore();
  });
});

describe('SessionService.resolve', () => {
  it('normalizes the profile and hands the repository the session id', async () => {
    const profile = 'resolve';
    const target = await install(profile, bestValidFile, 'wanted.duckdb');
    const guestCopy = await install('guest', bestValidFile, 'guest-wanted.duckdb');
    const { service } = createHarness();

    expect(await service.resolve(profile, 'wanted.duckdb')).toBe(target);
    // a blank or missing id is the guest profile - which is why it cannot see 'wanted.duckdb'.
    await expect(service.resolve('   ', 'wanted.duckdb')).rejects.toMatchObject({ status: 404 });
    expect(await service.resolve('', 'guest-wanted.duckdb')).toBe(guestCopy);
    expect(await service.resolve(null, 'guest-wanted.duckdb')).toBe(guestCopy);

    await expect(service.resolve(profile, 'missing.duckdb')).rejects.toMatchObject({ status: 404 });
    await expect(service.resolve(profile, '../outside.duckdb')).rejects.toMatchObject({ status: 400 });
    await expect(service.resolve(profile, 'notes.txt')).rejects.toMatchObject({ status: 400 });
  });

  it('satisfies the SetupService SessionResolver port', () => {
    const { service } = createHarness();
    const resolver: SessionResolver = service;
    expect(typeof resolver.resolve).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------------
// helpers for the pure-derivation tests
// ---------------------------------------------------------------------------------------------

function stubLap(overrides: Partial<LapInfo> = {}): LapInfo {
  return {
    lap: 0,
    startTime: 100,
    endTime: 130,
    duration: 30,
    isValid: true,
    isOutLap: true,
    inPit: false,
    fuelUsed: 0,
    s1: null,
    s2: null,
    s3: null,
    stint: 1,
    ...overrides,
  };
}

function stubMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    trackName: 'Sebring International Raceway',
    commonTrackName: 'Sebring International Raceway',
    trackAliases: ['Sebring'],
    country: 'United States',
    trackLayout: 'Default',
    layoutKey: 'Default',
    officialTrackLength: 6019,
    carClass: 'LMGT3',
    modelName: 'McLaren 720S GT3 Evo',
    rawCarName: 'United Autosports McLaren 720S GT3 Evo',
    driverName: 'A. Driver',
    sessionTime: '2026-10-25 18:00:00',
    sessionDuration: 160,
    sessionType: 'Race',
    weather: 'Light Rain',
    trackSectors: [],
    fuelCapacity: 70,
    tyreCompoundMax: 4,
    steeringLock: 520,
    steeringLockString: '520 degrees',
    ...overrides,
  };
}

/**
 * A LapService whose header() returns hand-written laps, so rules real session files cannot
 * produce are still pinned. The cast is needed because the class carries private state; only
 * the two members SessionService touches are provided.
 */
function stubbedService(
  laps: LapInfo[],
  identities: LapCacheIdentity[] = [],
  metadata: SessionMetadata = stubMetadata(),
): SessionService {
  const stub = {
    async header(_database: string, identity?: LapCacheIdentity): Promise<LapsResponse> {
      identities.push(identity ?? {});
      return { laps, metadata };
    },
    clearCache(): void {
      /* nothing to invalidate in a stub */
    },
  } as unknown as LapService;

  const repository = new SessionRepository(paths, new NoDiscordGateway(), fixtureLogger);
  return new SessionService(
    repository,
    stub,
    new TrackRegistry(fixtureLogger),
    fixtureLogger,
  );
}

async function stubRow(laps: LapInfo[], metadata?: SessionMetadata): Promise<SessionInfo> {
  const service = stubbedService(laps, [], metadata);
  const row = await service.scan(stubFile, 'stub-profile');
  expect(row.id).toBe('stub-session.duckdb');
  expect(row.name).toBe('stub-session');
  return row;
}

async function incomingFile(source: string, fileName: string): Promise<IncomingFile> {
  const buffer = await fs.promises.readFile(source);
  return { filename: fileName, stream: Readable.from(buffer), size: buffer.length };
}
