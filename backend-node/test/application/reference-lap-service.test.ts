import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { LapService } from '../../src/application/lap-service.js';
import { ReferenceLapService } from '../../src/application/reference-lap-service.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import { DuckDbConnectionFactory } from '../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import type {
  DiscordAttachmentMap,
  DiscordSessionGateway,
} from '../../src/infra/fs/session-repository.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import type { ReferenceLap } from '../../src/domain/types.js';
import {
  BARE_SESSION_SQL,
  FINGERPRINT_SESSION_SQL,
  MAIN_SESSION_SQL,
  buildSessionDatabase,
  cleanupLapFixtures,
  fixturePaths,
  fixtureLogger,
  installSession,
} from './fixtures.js';

/** `/reference-laps` never downloads anything; the repository only needs the port to exist. */
class NoDiscordGateway implements DiscordSessionGateway {
  async getThreadAttachments(): Promise<DiscordAttachmentMap | null> {
    return null;
  }
  async downloadFile(): Promise<void> {
    /* unused */
  }
}

const factory = new DuckDbConnectionFactory();

function createLapService(): LapService {
  return new LapService(
    factory,
    new MetadataReader(fixtureLogger),
    new TrackRegistry(fixtureLogger),
    new CarCatalog(),
    fixtureLogger,
  );
}

let paths: AppPaths;
let lapService: LapService;
let service: ReferenceLapService;

/** (sessionId, lap, stint, duration, isValid, s1, s2, s3, fuelUsed) - the scanned shape. */
function rowsOf(laps: ReferenceLap[]): (string | number | boolean | null)[][] {
  return laps.map((lap) => [
    lap.sessionId,
    lap.lap,
    lap.stint,
    lap.duration,
    lap.isValid,
    lap.s1,
    lap.s2,
    lap.s3,
    lap.fuelUsed,
  ]);
}

beforeAll(async () => {
  paths = fixturePaths();
  const main = await buildSessionDatabase('reference-main.duckdb', MAIN_SESSION_SQL);
  const bare = await buildSessionDatabase('reference-bare.duckdb', BARE_SESSION_SQL);
  const fingerprint = await buildSessionDatabase('reference-fingerprint.duckdb', FINGERPRINT_SESSION_SQL);

  await installSession(paths, 'guest', main, 'race-a.duckdb', 1_700_000_000);
  await installSession(paths, 'guest', bare, 'bare.duckdb', 1_700_000_200);
  await installSession(paths, 'guest', fingerprint, 'gte.duckdb', 1_700_000_400);
  // A second copy of the same session, stamped later, to pin the date ordering.
  await installSession(paths, 'guest', main, 'race-b.duckdb', 1_800_000_000);

  // Not a database at all: LapService throws, the scan must skip it (ReferenceLapService.java:83).
  await fs.writeFile(path.join(paths.profileDataDir('guest'), 'broken.duckdb'), 'not a duckdb file');

  lapService = createLapService();
  const repository = new SessionRepository(paths, new NoDiscordGateway(), fixtureLogger);
  service = new ReferenceLapService(repository, lapService, fixtureLogger);
}, 180_000);

afterAll(() => {
  cleanupLapFixtures();
});

describe('ReferenceLapService.find', () => {
  it('flattens every lap of a matching session with its session context', async () => {
    const laps = await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3');

    // race-a + race-b hold the same session data; 'gte.duckdb' is LMGT3 -> GTE, so it drops out.
    expect(laps).toHaveLength(12);
    expect(rowsOf(laps)).toEqual([
      ['race-b.duckdb', 6, 3, 31.5, true, 12.5, 8.5, 10.5, 0],
      ['race-b.duckdb', 5, 2, 29.75, true, null, null, null, 2.5],
      ['race-b.duckdb', 4, 2, 28, false, 13, null, null, 2],
      ['race-b.duckdb', 2, 1, 28.5, true, 11.5, 7.5, 9.5, 2.5],
      ['race-b.duckdb', 1, 1, 30.25, true, 12, 8, 10.25, 2.5],
      ['race-b.duckdb', 0, 1, 10, false, 77, null, null, 0.5],
      ['race-a.duckdb', 6, 3, 31.5, true, 12.5, 8.5, 10.5, 0],
      ['race-a.duckdb', 5, 2, 29.75, true, null, null, null, 2.5],
      ['race-a.duckdb', 4, 2, 28, false, 13, null, null, 2],
      ['race-a.duckdb', 2, 1, 28.5, true, 11.5, 7.5, 9.5, 2.5],
      ['race-a.duckdb', 1, 1, 30.25, true, 12, 8, 10.25, 2.5],
      ['race-a.duckdb', 0, 1, 10, false, 77, null, null, 0.5],
    ]);

    const first = laps[0];
    expect(first.sessionName).toBe('race-b');
    expect(first.date).toBe(1_800_000_000);
    expect(first.totalLaps).toBe(6);
    // max stint over the session's laps, 0 when there are none (ReferenceLapService.java:58).
    expect(first.stintCount).toBe(3);
    expect(first.driver).toBe('A. Driver');
    expect(first.sessionTime).toBe('2026-10-25 18:00:00');
    expect(first.carModel).toBe('McLaren 720S GT3 Evo');
    expect(first.rawCarName).toBe('United Autosports McLaren 720S GT3 Evo');

    const older = laps.find((lap) => lap.sessionId === 'race-a.duckdb');
    expect(older?.date).toBe(1_700_000_000);
  });

  it('sorts by date descending, then by lap descending', async () => {
    const laps = await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3');
    expect(laps.map((lap) => lap.date)).toEqual([...laps.map((lap) => lap.date)].sort((a, b) => b - a));
    expect(laps.filter((lap) => lap.sessionId === 'race-b.duckdb').map((lap) => lap.lap)).toEqual([
      6, 5, 4, 2, 1, 0,
    ]);
  });

  it('accepts an empty layout term against a session with no layout', async () => {
    const laps = await service.find('guest', 'Unknown Track', '', 'Unknown Class');

    // bare.duckdb has no metadata at all, so track/layout/class all sit on their fallbacks.
    expect(laps).toHaveLength(1);
    expect(rowsOf(laps)).toEqual([['bare.duckdb', 0, 1, 10, false, null, null, null, 0]]);
    expect(laps[0].sessionName).toBe('bare');
    expect(laps[0].totalLaps).toBe(1);
    expect(laps[0].stintCount).toBe(1);
  });

  it('requires an exact layout once the term is not empty', async () => {
    expect(await service.find('guest', 'Unknown Track', 'Unknown Track', 'Unknown Class')).toEqual([]);
    expect(await service.find('guest', 'Sebring International Raceway', 'Sebring', 'LMGT3')).toEqual([]);
  });

  it('filters on the car class term', async () => {
    // gte.duckdb matches the term but its only interval is 3s, below the 5s rule,
    // so it contributes no laps at all.
    expect(await service.find('guest', 'Sebring International Raceway', 'Default', 'GTE')).toEqual([]);
    expect(await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT2')).toEqual([]);
    expect(await service.find('guest', 'Sebring International Raceway', 'School Circuit', 'LMGT3')).toEqual([]);
    expect(await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3')).toHaveLength(12);
  });

  it('skips a session that cannot be read instead of failing the scan', async () => {
    const laps = await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3');
    expect(laps.every((lap) => lap.sessionId !== 'broken.duckdb')).toBe(true);
  });

  it('treats a blank or unknown profile as guest / empty', async () => {
    const asGuest = await service.find(null, 'Sebring International Raceway', 'Default', 'LMGT3');
    const asBlank = await service.find('   ', 'Sebring International Raceway', 'Default', 'LMGT3');
    expect(asGuest.map((lap) => lap.sessionId)).toEqual(
      (await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3')).map(
        (lap) => lap.sessionId,
      ),
    );
    expect(asBlank).toHaveLength(asGuest.length);
    expect(await service.find('nobody', 'Sebring International Raceway', 'Default', 'LMGT3')).toEqual([]);
  });

  it('trims the search terms like Java does', async () => {
    const padded = await service.find(
      'guest',
      '  Sebring International Raceway ',
      '  Default ',
      ' LMGT3 ',
    );
    expect(padded).toHaveLength(12);
  });

  it('reuses the LapService header cache across scans', async () => {
    const first = await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3');
    const second = await service.find('guest', 'Sebring International Raceway', 'Default', 'LMGT3');
    expect(second).toEqual(first);

    // The same file path resolves through LapService too, so the cached response is returned.
    const direct = await lapService.header(
      path.join(paths.profileDataDir('guest'), 'race-a.duckdb'),
    );
    expect(direct.laps).toHaveLength(first.filter((lap) => lap.sessionId === 'race-a.duckdb').length);
  });
});
