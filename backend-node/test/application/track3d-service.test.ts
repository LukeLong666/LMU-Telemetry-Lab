/**
 * Tests for the ported Track3DService (backend-java Track3DService.java, 413 lines).
 *
 * Everything runs on the shared synthetic fusion database (`test/helpers/duckdb-fixture.ts`,
 * Silverstone / National Circuit), composed with `fusionFixtureStatements` + `writeDatabase` so
 * no fixture data is recreated. Only the tables that decide the scenario are swapped:
 * `Lap` / `Lap Time` (which laps exist and how long they are), `In Pits` (stint splitting),
 * `Last Sector1` / `Last Sector2` (sector lines) and the GPS pair (geometry).
 *
 * Two assertion levels are kept apart deliberately:
 * - **STRUCTURE / INVARIANT**: key sets and their order, point counts, finiteness, `z >= 0`,
 *   unit tangents, the empty-response shape. These hold regardless of JVM/V8 differences.
 * - **NUMERIC (hand-derived, never from a Java run)**: values computed on paper from the fixture's
 *   own arithmetic - `Ground Speed` 216 km/h -> 60 m/s -> 0.6 m per 100 Hz frame, the official
 *   2639 m length that turns the 40 s lap's distances into 2639/2400 per 0.6 m, `lat = 45.62 +
 *   t*0.0001` / `lon = 4.41 + t*0.0002`, and the equirectangular projection's `cos(lat)` factor.
 *   These are asserted with a 1e-9 relative tolerance because `Math.cos` / `Math.hypot` /
 *   `Math.toRadians` are only required to agree with the JVM within half an ULP: the port is
 *   numerically equivalent, not bit-identical. Where a value only pins down Java's ALGORITHM
 *   (the uniform-grid bucket search) rather than a number a JVM produced, that is said in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Track3DService } from '../../src/application/track3d-service.js';
import { LapService } from '../../src/application/lap-service.js';
import { SessionService } from '../../src/application/session-service.js';
import { ApiException } from '../../src/api/error.js';
import type { Track3DPoint, Track3DResponse } from '../../src/domain/types.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import { DuckDbConnectionFactory } from '../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import {
  SessionRepository,
  type DiscordSessionGateway,
} from '../../src/infra/fs/session-repository.js';
import { FusionEngine } from '../../src/infra/fusion/fusion-engine.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import {
  LAP_DIST_INITIAL_OFFSET,
  fusionFixtureStatements,
  writeDatabase,
} from '../helpers/duckdb-fixture.js';
import { cleanupLapFixtures, fixturePaths, fixtureLogger } from './fixtures.js';

/** The GPS series `FUSION_FIXTURE_TABLES` writes (one row per second, 0..120). */
const LAT_AT_ZERO = 45.62;
const LAT_PER_SECOND = 0.0001;
const LON_AT_ZERO = 4.41;
const LON_PER_SECOND = 0.0002;
/** Silverstone / National Circuit's last reference point distance (tracks.json). */
const OFFICIAL_LENGTH = 2639;
/** The fixture's constant 216 km/h, which the engine divides by 3.6 -> exactly 60 m/s. */
const METRES_PER_FRAME = 0.6;
/** 3D views fuse at 100 Hz, so one frame is 0.01 s. */
const SECONDS_PER_FRAME = 0.01;
/**
 * A 40 s lap at 60 m/s covers 2400 m, but the frame sitting exactly on the next lap boundary
 * belongs to that segment (`lowerBound` is exclusive), so the last distance written for the lap
 * is 2399.4 m - one frame short. The scaling then normalises that frame to the official length.
 */
const FULL_LAP_SPAN = 2399.4;

/**
 * The two response shapes, typed against `domain/types.ts` so a renamed or misspelled key is a
 * COMPILE error here and not only a failing assertion. Order matters: Jackson serialises Java
 * records in component order, and `Object.keys` on the port reproduces that insertion order.
 */
const POINT_KEYS: readonly (keyof Track3DPoint)[] = [
  'x',
  'y',
  'z',
  'd',
  'speed',
  'throttle',
  'brake',
  'lat',
  'width',
  'in_pits',
  'raw_lat',
  'raw_lon',
];

const RESPONSE_KEYS: readonly (keyof Track3DResponse)[] = [
  'baseMap',
  'racingLine',
  'trackName',
  'trackLayout',
  'layoutKey',
  'fastestLap',
  'selectedLapInfo',
  'trackSectors',
  'center',
  'zBase',
];

function gpsLat(time: number): number {
  return LAT_AT_ZERO + time * LAT_PER_SECOND;
}

function gpsLon(time: number): number {
  return LON_AT_ZERO + time * LON_PER_SECOND;
}

/** 1e-9 relative to the magnitude, with a 1.0 floor so tiny values get a 1e-9 absolute window. */
function expectClose(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Number.isFinite(actual)).toBe(true);
  const scale = Math.max(1.0, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance * scale);
}

/** The session files this suite writes straight into the guest profile's data directory. */
let paths: AppPaths;
let profileId = 'guest';
const writtenFiles: string[] = [];

/** `SessionRepository`'s Discord port - `discord__` ids are never used here. */
const unusedDiscordGateway: DiscordSessionGateway = {
  async getThreadAttachments() {
    throw new Error('not used by the 3D track tests');
  },
  async downloadFile() {
    throw new Error('not used by the 3D track tests');
  },
};

/**
 * Builds one variant of the shared fusion fixture and returns the session id to request it with.
 * `overrides` replaces named tables (they are dropped from the generated statements first), so a
 * scenario only states what differs from `test/helpers/duckdb-fixture.ts`.
 */
async function installVariant(
  fileName: string,
  options: {
    overrides?: Record<string, readonly string[]>;
    omitTables?: readonly string[];
  } = {},
): Promise<string> {
  const overrides = options.overrides ?? {};
  const statements = fusionFixtureStatements({
    omitTables: [...Object.keys(overrides), ...(options.omitTables ?? [])],
  });
  for (const sql of Object.values(overrides)) {
    statements.push(...sql);
  }
  const target = path.join(paths.profileDataDir(profileId), fileName);
  await writeDatabase(target, statements);
  writtenFiles.push(target);
  return fileName;
}

function eventTableSql(table: string, rows: string): string[] {
  return [`CREATE TABLE "${table}" (ts DOUBLE, value DOUBLE)`, `INSERT INTO "${table}" VALUES ${rows}`];
}

function frameTableSql(table: string, select: string): string[] {
  return [`CREATE TABLE "${table}" (value DOUBLE)`, `INSERT INTO "${table}" ${select}`];
}

/** A fresh service graph per suite, so no header/fusion cache is shared between scenarios. */
function createTrack3DService(): Track3DService {
  const connections = new DuckDbConnectionFactory();
  const metadataReader = new MetadataReader(fixtureLogger);
  const registry = new TrackRegistry(fixtureLogger);
  const carCatalog = new CarCatalog();
  const lapService = new LapService(connections, metadataReader, registry, carCatalog, fixtureLogger);
  const sessionService = new SessionService(
    new SessionRepository(paths, unusedDiscordGateway, fixtureLogger),
    lapService,
    registry,
    fixtureLogger,
  );
  const fusionEngine = new FusionEngine(
    connections,
    metadataReader,
    registry,
    carCatalog,
    fixtureLogger,
  );
  return new Track3DService(sessionService, lapService, fusionEngine);
}

let service: Track3DService;

// ---------------------------------------------------------------------------------------------
// Scenarios. Every lap window below is hand-derivable from the fixture:
//
// DEFAULT   - Lap 30/70, Lap Time 30->25 / 70->40, In Pits 30/34/70/74, no sector tables.
//             laps: 0 [0,30] 25.0 valid OUT stint 1 | 1 [30,70] 40.0 valid stint 1 (in-pit)
//             | 2 [70,120] 50.0 INVALID out-lap stint 2.
// SELECT    - Lap 30/50/75, Lap Time 50->20 / 75->25, no pits: one stint, lap 1 = 20 s and
//             lap 2 = 25 s both valid and neither an out-lap -> the SHORTER one is the base map.
// TOO_SHORT - boundaries 30/35.5/60.5 (the Lap Time at 35.5 is 4.9 s, i.e. 30.6 s - too close
//             to the first boundary for the resolver's inferred start, so no extra boundary):
//             lap 1 [30,35.5] is VALID with a matched duration of 4.9 s and lap 2 [35.5,60.5] is
//             valid at 25 s -> the sub-5 s winner is discarded in favour of the requested lap 2.
// ANCHOR    - boundaries 0/3/8/38 (the 3 s first interval is dropped by LapService) and lap 1 is
//             exactly 5.0 s long -> requesting lap 2 puts `firstLap` (8 <= 3 + 5) exactly on the
//             tolerance, so the racing line extends back to the stint start while the base map
//             stays on lap 1.
// LONG      - Lap 30 + Lap Time 120->90 -> lap 1 spans 90 s = 9001 frames -> step 2 downsampling.
// SECTORS   - DEFAULT + Last Sector1 (40 -> 10.0) / Last Sector2 (55 -> 22.0): lap 1 gets
//             s1 = 10, s2 = 12, so the markers land at t = 40 (frame 1000) and t = 52 (frame 2200).
// FLAT_GPS  - DEFAULT with constant GPS coordinates: every projected point is the same, which is
//             how the `magnitude == 0` and the grid tie-breaking branches are reached.
// NO_GPS    - DEFAULT without "GPS Latitude": extraction fails and the empty response ships.
// ---------------------------------------------------------------------------------------------

let defaultSession = '';
let selectSession = '';
let tooShortSession = '';
let anchorSession = '';
let longSession = '';
let sectorSession = '';
let flatSession = '';
let noGpsSession = '';

beforeAll(async () => {
  paths = fixturePaths();
  profileId = 'guest';
  service = createTrack3DService();

  defaultSession = await installVariant('track3d-default.duckdb');
  selectSession = await installVariant('track3d-select.duckdb', {
    overrides: {
      Lap: eventTableSql('Lap', '(30.0, 1.0), (50.0, 2.0), (75.0, 3.0)'),
      'Lap Time': eventTableSql('Lap Time', '(50.0, 20.0), (75.0, 25.0)'),
      'In Pits': [],
    },
  });
  tooShortSession = await installVariant('track3d-too-short.duckdb', {
    overrides: {
      Lap: eventTableSql('Lap', '(30.0, 1.0), (35.5, 2.0), (60.5, 3.0)'),
      'Lap Time': eventTableSql('Lap Time', '(35.5, 4.9), (60.5, 25.0)'),
      'In Pits': [],
    },
  });
  anchorSession = await installVariant('track3d-anchor.duckdb', {
    overrides: {
      Lap: eventTableSql('Lap', '(3.0, 1.0), (8.0, 2.0), (38.0, 3.0)'),
      'Lap Time': eventTableSql('Lap Time', '(8.0, 5.0), (38.0, 30.0)'),
      'In Pits': [],
    },
  });
  longSession = await installVariant('track3d-long.duckdb', {
    overrides: {
      Lap: eventTableSql('Lap', '(30.0, 1.0)'),
      'Lap Time': eventTableSql('Lap Time', '(120.0, 90.0)'),
      'In Pits': [],
    },
  });
  sectorSession = await installVariant('track3d-sectors.duckdb', {
    overrides: {
      'Last Sector1': eventTableSql('Last Sector1', '(40.0, 10.0)'),
      'Last Sector2': eventTableSql('Last Sector2', '(55.0, 22.0)'),
    },
  });
  flatSession = await installVariant('track3d-flat-gps.duckdb', {
    overrides: {
      'GPS Latitude': frameTableSql('GPS Latitude', `SELECT ${LAT_AT_ZERO} FROM range(121) t(x)`),
      'GPS Longitude': frameTableSql('GPS Longitude', `SELECT ${LON_AT_ZERO} FROM range(121) t(x)`),
      'Last Sector1': eventTableSql('Last Sector1', '(40.0, 10.0)'),
      'Last Sector2': eventTableSql('Last Sector2', '(55.0, 22.0)'),
    },
  });
  noGpsSession = await installVariant('track3d-no-gps.duckdb', {
    omitTables: ['GPS Latitude'],
  });
}, 240_000);

afterAll(() => {
  for (const file of writtenFiles) {
    fs.rmSync(file, { force: true });
  }
  cleanupLapFixtures();
});

describe('Track3DService response contract', () => {
  it('emits the Java record\'s fields in the Java order, with the mixed-case point keys', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);

    // STRUCTURE: `Track3DResponse`'s record component order (backend-java Track3DResponse.java).
    expect(Object.keys(response)).toEqual([...RESPONSE_KEYS]);
    expect(Object.keys(response.center)).toEqual(['lat', 'lon', 'lonScale']);

    // The snake_case trio `in_pits` / `raw_lat` / `raw_lon` plus the nine camelCase fields, again
    // in record order (Track3DPoint.java). `lat` sits between brake and width on purpose.
    expect(response.baseMap.length).toBeGreaterThan(0);
    expect(Object.keys(response.baseMap[0])).toEqual([...POINT_KEYS]);
    expect(Object.keys(response.racingLine[0])).toEqual([...POINT_KEYS]);
    // STRUCTURE: no `Last Sector1`/`Last Sector2` tables in the shared fixture -> no markers.
    expect(response.trackSectors).toEqual([]);
    expect(Object.keys(response.selectedLapInfo)).toEqual([
      'lap',
      'startTime',
      'endTime',
      'duration',
      'isValid',
      'isOutLap',
      'inPit',
      'fuelUsed',
      's1',
      's2',
      's3',
      'stint',
    ]);
  });

  it('keeps the metadata text fields and the selected lap as Java reads them', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);

    // STRUCTURE + hand-derived values: the metadata reader's raw values, and the requested lap.
    expect(response.trackName).toBe('Silverstone');
    expect(response.trackLayout).toBe('National Circuit');
    expect(response.layoutKey).toBe('National Circuit');
    expect(response.selectedLapInfo.lap).toBe(1);
    expect(response.selectedLapInfo.startTime).toBe(30);
    expect(response.selectedLapInfo.endTime).toBe(70);
    expect(response.selectedLapInfo.stint).toBe(1);
    expect(response.fastestLap).toBe(1);
  });

  it('sanitizes every emitted number so the JSON never carries NaN or Infinity', async () => {
    const response = await service.build(profileId, defaultSession, 0, null);
    // STRUCTURE: `safe()` on all 12 point fields plus the sector and centre fields.
    const allPoints = [...response.baseMap, ...response.racingLine];
    for (const point of allPoints) {
      for (const value of Object.values(point)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    for (const value of Object.values(response.center)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(Number.isFinite(response.zBase)).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/NaN|Infinity/);
  });

  it('returns a 404 for an unknown lap and keeps the controller\'s lap guard outside the service', async () => {
    await expect(service.build(profileId, defaultSession, 99, null)).rejects.toMatchObject({
      status: 404,
      message: 'Lap not found',
    });
    // Java's Track3DController.java:29 turns `lap < 0` into 400 BEFORE calling the service;
    // the service itself only ever 404s, which is what the route must reproduce.
    await expect(service.build(profileId, defaultSession, -1, null)).rejects.toBeInstanceOf(
      ApiException,
    );
  });

  it('lets the session resolution fail with the repository\'s own status codes', async () => {
    await expect(service.build(profileId, 'missing-session.duckdb', 0, null)).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
    });
    await expect(service.build(profileId, 'notes.txt', 0, null)).rejects.toMatchObject({
      status: 400,
      message: 'Only .duckdb files are supported',
    });
  });

  it('falls back to the lap at that index when the stint filter matches nothing', async () => {
    // Track3DService.java:49-51: `lapNumber` still in range -> `laps.get(lapNumber)`.
    const response = await service.build(profileId, defaultSession, 1, 9);
    expect(response.selectedLapInfo.lap).toBe(1);
    expect(response.selectedLapInfo.stint).toBe(1);
    expect(response.baseMap.length).toBe(4001);
  });
});

describe('Track3DService shortest-valid-lap base map (Java rule 1)', () => {
  it('builds the base map from the shortest valid lap of the stint, not the requested lap', async () => {
    const response = await service.build(profileId, selectSession, 2, null);

    // NUMERIC (hand-derived): lap 1 is valid, not an out-lap and 20 s; lap 2 (requested) is 25 s.
    expect(response.fastestLap).toBe(1);
    expect(response.selectedLapInfo.lap).toBe(2);
    // 20 s at 100 Hz = 2001 frames for the base map, 25 s = 2501 for the racing line.
    expect(response.baseMap.length).toBe(2001);
    expect(response.racingLine.length).toBe(2501);

    // The base window is [30, 50] and the racing window [50, 75] - a 0.002 deg difference,
    // orders of magnitude above the 1e-9 tolerance, so this pins the choice of lap.
    expectClose(response.baseMap[0].raw_lat, gpsLat(30));
    expectClose(response.baseMap[2000].raw_lat, gpsLat(50));
    expectClose(response.racingLine[0].raw_lat, gpsLat(50));
    expectClose(response.racingLine[2500].raw_lat, gpsLat(75));
    expectClose(response.baseMap[0].raw_lon, gpsLon(30));
  });

  it('ignores invalid and out-laps when picking the base map', async () => {
    // Lap 0 IS valid-but-out-lap and lap 2 is 50 s but INVALID in the default session, so the
    // only candidate in stint 1 is lap 1 - the fallback chain (max duration) is not reached.
    const response = await service.build(profileId, defaultSession, 0, null);
    expect(response.fastestLap).toBe(1);
    expect(response.selectedLapInfo.lap).toBe(0);
    // Base map 30..70 (4001 frames), racing line 0..30 (3001 frames): the two windows differ.
    expect(response.baseMap.length).toBe(4001);
    expect(response.racingLine.length).toBe(3001);
  });

  it('falls back to the longest stint lap when no valid lap exists', async () => {
    // Stint 2 holds only lap 2 (invalid) -> `validLaps` empty -> max over the stint = lap 2.
    const response = await service.build(profileId, defaultSession, 2, null);
    expect(response.fastestLap).toBe(2);
    expect(response.baseMap.length).toBe(5001);
    expectClose(response.baseMap[0].raw_lat, gpsLat(70));
  });

  it('discards a base lap shorter than 5.0 s and keeps the selected lap instead', async () => {
    // Track3DService.java:73-75. Lap 1 wins the duration scan with a matched 4.9 s (< the raw
    // 5.5 s interval, which LapService keeps), so 4.9 < 5.0 writes the REQUESTED lap 2 (25 s)
    // back into `best` - including `fastestLap`, which therefore reports 2.
    const response = await service.build(profileId, tooShortSession, 2, null);
    expect(response.fastestLap).toBe(2);
    expect(response.baseMap.length).toBe(2501);
    expectClose(response.baseMap[0].raw_lat, gpsLat(35.5));
  });
});

describe('Track3DService stint anchoring (Java rule 2)', () => {
  it('extends the racing line to the stint start when the selected lap starts within 5 s', async () => {
    const response = await service.build(profileId, anchorSession, 2, null);

    // NUMERIC (hand-derived): the 3 s first interval is dropped, so the stint starts at lap 1
    // (t = 3 s, 5.0 s long) and lap 2 starts at t = 8 s -> `firstLap` (8 <= 3 + 5) holds exactly
    // on the tolerance, while `lastLap` (38 >= 120 - 5) does not.
    expect(response.selectedLapInfo.lap).toBe(2);
    expect(response.selectedLapInfo.startTime).toBe(8);
    expect(response.selectedLapInfo.endTime).toBe(38);
    expect(response.fastestLap).toBe(1);
    // Base map = lap 1 = 5.0 s * 100 Hz (+1 endpoint) = 501 frames; the racing line spans the
    // stint start..lap end = [3, 38] = 3501 frames.
    expect(response.baseMap.length).toBe(501);
    expect(response.racingLine.length).toBe(3501);
    expectClose(response.baseMap[0].raw_lat, gpsLat(3));
    expectClose(response.racingLine[0].raw_lat, gpsLat(3));
    // The extension is one-sided: the racing line still stops at the lap end, and it contains
    // the base map's own start frame at index 500.
    expectClose(response.racingLine[3500].raw_lat, gpsLat(38));
    expectClose(response.racingLine[500].raw_lat, gpsLat(8));
  });

  it('anchors both ends on the stint when the selected lap is the stint\'s only lap', async () => {
    // Lap 2 is the only member of stint 2: firstLap and lastLap both hold, and the stint edges
    // coincide with the lap edges, so the 5001 frames of [70, 120] are all the racing line gets.
    const response = await service.build(profileId, defaultSession, 2, null);
    expect(response.racingLine.length).toBe(5001);
    expectClose(response.racingLine[0].raw_lat, gpsLat(70));
    expectClose(response.racingLine[5000].raw_lat, gpsLat(120));
  });

  it('keeps the projection centre on the base lap even when the racing line reaches further back', async () => {
    const response = await service.build(profileId, anchorSession, 2, null);

    // NUMERIC (hand-derived): mean of an evenly sampled linear series = its midpoint value, so
    // centre lat is the latitude at t = 5.5 (the middle of the base lap [3, 8]) and NOT of the
    // racing window [3, 38].
    expectClose(response.center.lat, gpsLat(5.5));
    expectClose(response.center.lon, gpsLon(5.5));
    // cos(radians(centre lat)) - the equirectangular longitude compression Java does by hand.
    expectClose(response.center.lonScale, Math.cos((gpsLat(5.5) / 180.0) * Math.PI));
    expect(response.center.lonScale).toBeGreaterThan(0.69);
    expect(response.center.lonScale).toBeLessThan(0.71);
  });
});

describe('Track3DService projection, centre and elevation plane', () => {
  it('projects every point from its own raw lat/lon against the reported centre', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // NUMERIC (hand-derived, and self-consistent): x = (lon - centreLon) * lonScale * 111320,
    // y = (lat - centreLat) * 111320. Recomputed from the response's own fields, so a wrong
    // DEG_TO_M, a missing cos() or a swapped axis all fail here.
    for (const index of [0, 500, 1973, 4000]) {
      const point = response.baseMap[index];
      expectClose(point.x, (point.raw_lon - response.center.lon) * response.center.lonScale * 111320);
      expectClose(point.y, (point.raw_lat - response.center.lat) * 111320);
    }
    // NUMERIC (hand-derived): the fixture's GPS series is a straight diagonal, so every projected
    // point has the same metre slope y/x = LAT_PER_SECOND / (LON_PER_SECOND * lonScale) - which is
    // only true if the longitude got cos(lat) and the latitude did not. Index 2000 is the centre
    // point itself (x = y = 0) and is skipped.
    for (const index of [0, 500, 4000]) {
      const point = response.baseMap[index];
      expectClose(point.y / point.x, LAT_PER_SECOND / (LON_PER_SECOND * response.center.lonScale), 1e-9);
    }
  });

  it('puts the centre on the mean of the base map and the plane on its lowest z', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // Base window [30, 70] -> centre is the latitude/longitude at t = 50.
    expectClose(response.center.lat, gpsLat(50));
    expectClose(response.center.lon, gpsLon(50));

    // NUMERIC: `zBase = min(WorldPosZ)` over the base frames, so the base map's own minimum z is
    // exactly 0 (the argmin index is always sampled at step 1) and nothing dips below it.
    const baseZ = response.baseMap.map((point) => point.z);
    expect(Math.min(...baseZ)).toBe(0);
    expect(Math.max(...baseZ)).toBeGreaterThan(0);
    for (const point of response.baseMap) {
      expect(point.z).toBeGreaterThanOrEqual(0);
    }
    // Silverstone National's profile spans 150.5..155.8 m and the distance sweep covers it all.
    expect(response.zBase).toBeGreaterThan(150.0);
    expect(response.zBase).toBeLessThan(156.0);
  });

  it('snaps the racing line onto base-map elevations instead of its own', async () => {
    const response = await service.build(profileId, sectorSession, 1, null);
    // STRUCTURE: with the base and racing windows both being [30, 70] here, the two lines have
    // identical geometry - the z values are the only thing the snapping can change.
    expect(response.baseMap.length).toBe(4001);
    expect(response.racingLine.length).toBe(4001);
    for (const index of [0, 1000, 2200, 4000]) {
      expect(response.racingLine[index].x).toBe(response.baseMap[index].x);
      expect(response.racingLine[index].y).toBe(response.baseMap[index].y);
    }

    // INVARIANT: every snapped z is `base.z[j] - zBase` for SOME base frame j, and all base
    // frames are sampled at step 1, so the racing z values all appear in the base map.
    const baseZValues = new Set(response.baseMap.map((point) => point.z));
    for (const index of [0, 1, 123, 1000, 3999, 4000]) {
      const z = response.racingLine[index].z;
      expect(z).toBeGreaterThanOrEqual(0);
      expect(baseZValues.has(z)).toBe(true);
    }

    // BEHAVIOUR of Java's uniform grid (Track3DService.java:366-405), asserted rather than copied:
    // the query point (the very first racing frame) is EXACTLY the first base point, so a true
    // nearest-neighbour search would return that index and `racingLine[0].z` would equal
    // `baseMap[0].z`. Java instead buckets by `floor(px / CELL)` and then feeds the cell INDEX
    // back into `key()`, which divides by CELL a second time - so the home bucket (cell -16, -12)
    // is looked up as bucket (-1, -1) and the winner is the closest point inside that collapsed
    // bucket (the track centre near x = y = 0), not the point itself.
    expect(response.baseMap[0].z).toBeGreaterThan(0);
    expect(response.racingLine[0].z).not.toBe(response.baseMap[0].z);
  });
});

describe('Track3DService 4000-point downsampling (Java rule 4)', () => {
  it('samples every frame while the window holds fewer than 8000 frames', async () => {
    // NUMERIC: `step = max(1, length / 4000)` with integer division, so 5001 frames -> step 1.
    const response = await service.build(profileId, defaultSession, 2, null);
    expect(response.baseMap.length).toBe(5001);
    expectClose(response.baseMap[1].raw_lat - response.baseMap[0].raw_lat, LAT_PER_SECOND * SECONDS_PER_FRAME, 1e-12);
  });

  it('uses a stride of 2 above 8000 frames and is NOT capped at 4000 points', async () => {
    // The 90 s lap (lap 1 of the LONG session) is 9001 frames -> step = trunc(9001/4000) = 2.
    const response = await service.build(profileId, longSession, 1, null);
    expect(response.baseMap.length).toBe(4501);
    expect(response.baseMap.length).toBeGreaterThan(4000);
    expect(response.racingLine.length).toBe(4501);

    // INVARIANT: the walk starts at index 0, so the first frame is always kept, and with 9001
    // frames (9000 % 2 === 0) the last frame is kept too - Java appends nothing else.
    expectClose(response.baseMap[0].raw_lat, gpsLat(30));
    expectClose(response.baseMap[4500].raw_lat, gpsLat(120));

    // NUMERIC (hand-derived): 60 m/s over a 0.01 s frame = 0.6 m, and the 5400 m this lap drives
    // is 2.05x the 2639 m reference, so the engine leaves it unscaled: every output point is 2
    // frames apart -> 1.2 m of `d`, ending at 5400 m.
    expectClose(response.baseMap[0].d, 0);
    expectClose(response.baseMap[10].d, 12);
    expectClose(response.baseMap[4500].d, 5400);
    expectClose(response.baseMap[1].raw_lat - response.baseMap[0].raw_lat, 2 * LAT_PER_SECOND * SECONDS_PER_FRAME, 1e-12);
  });

  it('scales the reference lap onto the official length instead of downsampling it', async () => {
    // The 40 s lap drives 2399.4 m of written frames, ratio 2399.4/2639 = 0.909 inside the
    // 0.8..1.2 band, so the fusion engine rescales by 2639/2399.4: `d` grows by
    // 0.6 * 2639/2399.4 per frame and the last written frame lands exactly on the official
    // length. Nothing is dropped (4001 < 8000 -> step 1).
    const response = await service.build(profileId, sectorSession, 1, null);
    expect(response.baseMap.length).toBe(4001);
    expectClose(response.baseMap[0].d, 0);
    expectClose(response.baseMap[1000].d, 600 * (OFFICIAL_LENGTH / FULL_LAP_SPAN));
    expectClose(response.baseMap[3999].d, OFFICIAL_LENGTH, 1e-8);
    // The master frame AT the boundary belongs to the next lap segment, so it is left at the
    // Float64Array default: Java ships 0.0 here too (the racing line's closure point).
    expect(response.baseMap[4000].d).toBe(0);
  });

  it('carries the session\'s initial Lap Dist offset into the first unscaled lap', async () => {
    // Lap 0 of the default session is segment 0, which adds the recorded offset (100 m) and stays
    // unscaled (ratio 1899.4/2639 = 0.72). The frame exactly on t = 30 s belongs to segment 1 and
    // is therefore written from that segment's base, i.e. 0.
    const response = await service.build(profileId, defaultSession, 0, null);
    expect(response.racingLine.length).toBe(3001);
    expectClose(response.racingLine[0].d, LAP_DIST_INITIAL_OFFSET);
    expectClose(response.racingLine[1].d, LAP_DIST_INITIAL_OFFSET + METRES_PER_FRAME);
    expectClose(
      response.racingLine[2999].d,
      LAP_DIST_INITIAL_OFFSET + 2999 * METRES_PER_FRAME,
      1e-8,
    );
    expect(response.racingLine[3000].d).toBe(0);
  });
});

describe('Track3DService channel fallbacks and field mapping', () => {
  it('maps Track3DPoint.lat to the lateral offset and keeps the GPS pair in raw_lat/raw_lon', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // NUMERIC: the fixture has no "Path Lateral" table, so `lat` is Java's 0.0 fallback while
    // raw_lat/raw_lon hold the real coordinates. Asserting lat === 0 here is what proves the
    // odd Java mapping (Track3DService.java:197) is not "fixed" into a sensible lat = latitude.
    const point = response.baseMap[100];
    expect(point.lat).toBe(0);
    expectClose(point.raw_lat, gpsLat(31));
    expectClose(point.raw_lon, gpsLon(31));
  });

  it('falls back to a 7.5 m track width and 0 for every other missing channel', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // `valueAt(width, i, 7.5)` is the only non-zero fallback in the service.
    for (const point of [response.baseMap[0], response.baseMap[2001]]) {
      expect(point.width).toBe(7.5);
      expect(point.brake).toBe(0);
      // STRUCTURE: `Track3DPoint` has no `lateral` component (only `Track3DSectorPoint` does), so
      // the JSON must not gain one - the lateral offset leaves as `lat`.
      expect('lateral' in point).toBe(false);
    }
    expect(response.baseMap.every((point) => point.width === 7.5)).toBe(true);
    expect(response.baseMap.every((point) => point.brake === 0)).toBe(true);
  });

  it('treats an unrecorded throttle reading as 0 and truncates the pit flag to an int', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // "Throttle Pos" is 0.8 except for SQL NULLs at rows 60 and 61 -> NaN frames -> Java's 0.0.
    expect(response.baseMap[100].throttle).toBeCloseTo(0.8, 10);
    expect(response.baseMap[3100].throttle).toBe(0);
    // "In Pits" is change-only: the true event at t=30 lands on the base window's frame 0, the
    // false event at t=34 on frame 400, and every other frame is NaN -> 0. `in_pits` is Java's
    // `(int)` narrowing, so it must be an integer, not 1.0-shaped-as-a-fraction.
    expect(response.baseMap[0].in_pits).toBe(1);
    expect(response.baseMap[1].in_pits).toBe(0);
    expect(response.baseMap[400].in_pits).toBe(0);
    expect(response.baseMap.every((point) => Number.isInteger(point.in_pits))).toBe(true);
  });

  it('reads ground speed with the GPS-speed fallback the fusion engine already resolved', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // The fused "Ground Speed" channel is the raw table value resampled onto the master grid:
    // 216 km/h. The 3.6 division in the fusion engine only feeds its private distance
    // integration copy, so the chart value stays in km/h - which is what Java ships and what
    // Python's `v * 3.6` produces as well.
    expect(response.baseMap[0].speed).toBeCloseTo(216, 6);
  });
});

describe('Track3DService sector markers (Java rule 3 companion)', () => {
  it('omits sector lines entirely when the base lap has no sector splits', async () => {
    const response = await service.build(profileId, defaultSession, 1, null);
    // STRUCTURE: the shared fixture has no "Last Sector1"/"Last Sector2" tables, so s1/s2 are
    // null and `buildSectors` returns an empty list before any marker math.
    expect(response.trackSectors).toEqual([]);
  });

  it('places three markers, the two sector ones at the split times of the base lap', async () => {
    const response = await service.build(profileId, sectorSession, 1, null);
    // NUMERIC (hand-derived): t1 = 30 + 10 = 40 -> frame 1000, t2 = 40 + 12 = 52 -> frame 2200 on
    // the base window's 100 Hz grid; the first marker is the start/finish frame 0.
    expect(response.trackSectors.length).toBe(3);
    expect(response.trackSectors.map((point) => point.id)).toEqual([0, 1, 2]);
    expect(Object.keys(response.trackSectors[0])).toEqual([
      'id',
      'x',
      'y',
      'dx',
      'dy',
      'z',
      'dist',
      'lat',
      'lon',
      'lateral',
      'width',
    ]);

    for (const [marker, index] of [
      [response.trackSectors[1], 1000],
      [response.trackSectors[2], 2200],
    ] as const) {
      // The marker coordinates are the base map's own, byte for byte (`safe(x[index])`).
      expect(marker.x).toBe(response.baseMap[index].x);
      expect(marker.y).toBe(response.baseMap[index].y);
      expect(marker.z).toBe(response.baseMap[index].z);
      expect(marker.dist).toBe(response.baseMap[index].d);
      // Track3DSectorPoint.lat/lon ARE the real coordinates (unlike Track3DPoint.lat), and its
      // `lateral`/`width` follow the same fallback chain.
      expectClose(marker.lat, gpsLat(40 + (index - 1000) * SECONDS_PER_FRAME));
      expectClose(marker.lon, gpsLon(40 + (index - 1000) * SECONDS_PER_FRAME));
      expect(marker.lateral).toBe(0);
      expect(marker.width).toBe(7.5);
    }
  });

  it('reports a normalised tangent for the mid-lap markers', async () => {
    const response = await service.build(profileId, sectorSession, 1, null);
    for (const marker of [response.trackSectors[1], response.trackSectors[2]]) {
      // INVARIANT: dx/dy are divided by `hypot` (5 frames either side), so the vector has unit
      // length. Java does NOT special-case anything else: it only replaces an exactly-zero
      // magnitude with 1.0 to keep the division finite.
      expectClose(Math.hypot(marker.dx, marker.dy), 1, 1e-9);
      // NUMERIC (hand-derived): the tangent spans 10 frames of the fixture's diagonal, whose
      // metre slope is (0.0001 * 111320) / (0.0002 * 111320 * lonScale) = 0.5 / lonScale.
      expectClose(marker.dy / marker.dx, 0.5 / response.center.lonScale, 1e-8);
      expect(marker.dx).toBeGreaterThan(0);
      expect(marker.dy).toBeGreaterThan(0);
    }
    // Sector 0 wraps the window (`floorMod(-5, n)` vs `floorMod(+5, n)`), and because the fixture
    // is a line rather than a loop that wrap points backwards - unit length still holds.
    const startMarker = response.trackSectors[0];
    expectClose(Math.hypot(startMarker.dx, startMarker.dy), 1, 1e-9);
    expect(startMarker.dx).toBeLessThan(0);
  });

  it('keeps a zero tangent finite when the geometry has no extent at all', async () => {
    const response = await service.build(profileId, flatSession, 1, null);
    // STRUCTURE + the `magnitude == 0 -> 1.0` branch: every point coincides, so dx and dy are the
    // literal 0 (without the guard they would be NaN, which `safe()` would then hide as 0 too).
    expect(response.trackSectors.length).toBe(3);
    // Markers sit at base frames 0, 1000 and 2200; the z of each is its own base frame's
    // elevation (the WorldPosZ model still varies with lap distance even though x/y do not).
    const markerFrames = [0, 1000, 2200];
    response.trackSectors.forEach((marker, position) => {
      expect(marker.dx).toBe(0);
      expect(marker.dy).toBe(0);
      expectClose(marker.x, 0, 1e-6);
      expectClose(marker.y, 0, 1e-6);
      expect(marker.z).toBe(response.baseMap[markerFrames[position]].z);
    });
    // Grid tie-breaking: all base points are 0 m away from the query, `distance < bestDistance`
    // keeps the FIRST candidate, and the home bucket holds every index, so the snapped z is
    // always base.z[0] - the whole racing line collapses onto one elevation.
    const snapped = new Set(response.racingLine.map((point) => point.z));
    expect(snapped.size).toBe(1);
    expect(response.racingLine[0].z).toBe(response.baseMap[0].z);
    expect(response.racingLine.length).toBe(response.baseMap.length);
  });
});

describe('Track3DService empty response (extraction failure)', () => {
  it('ships an empty geometry with an identity centre when the GPS table is missing', async () => {
    const response = await service.build(profileId, noGpsSession, 0, null);
    // Track3DService.java:124-129: `extract` returns null (no "GPS Latitude" channel), so the
    // response keeps the metadata and the lap info but has no geometry at all.
    expect(response.baseMap).toEqual([]);
    expect(response.racingLine).toEqual([]);
    expect(response.trackSectors).toEqual([]);
    expect(response.center).toEqual({ lat: 0, lon: 0, lonScale: 1 });
    expect(response.zBase).toBe(0);
    expect(response.trackName).toBe('Silverstone');
    expect(response.trackLayout).toBe('National Circuit');
    expect(response.fastestLap).toBe(1);
    expect(response.selectedLapInfo.lap).toBe(0);
    expect(Object.keys(response)).toEqual([...RESPONSE_KEYS]);
  });
});
