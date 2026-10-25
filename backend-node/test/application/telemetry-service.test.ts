/**
 * Port of the TelemetryService.java use case onto the shared fusion fixture.
 *
 * The interesting assertions are the trim windows: they are where `stint_id` / `lap_id` become
 * `FusionOptions.trimStart/trimEnd`, and the frame length plus its first/last timestamp pin the
 * window exactly (10 Hz over [30, 70] is 401 frames, and nothing else produces that).
 *
 * Fixture recap (`test/helpers/duckdb-fixture.ts`): GPS Time 0..120 at 1 Hz -> 1201 frames at
 * 10 Hz; `Lap` events at 30 s and 70 s -> boundaries [0, 30, 70]; `In Pits` true at 30 and 70 ->
 * LapService yields lap 0 (0..30, stint 1, no pit), lap 1 (30..70, stint 1, in pit), lap 2
 * (70..120, stint 2, in pit). Ground Speed is a constant 216 km/h, Susp Pos is the per-wheel
 * constant (-0.5, 0.5, -1.0, 1.5) which the fusion engine flips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channel } from '../../src/domain/types.js';
import { ApiException } from '../../src/api/error.js';
import { memorySink, writeTelemetryJson } from '../../src/api/telemetry-writer.js';
import { LapService } from '../../src/application/lap-service.js';
import { SessionService } from '../../src/application/session-service.js';
import {
  TelemetryService,
  assertFrequency,
  suspensionBaselines,
} from '../../src/application/telemetry-service.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import { DuckDbConnectionFactory } from '../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import { SessionRepository, type DiscordSessionGateway } from '../../src/infra/fs/session-repository.js';
import { FusionEngine } from '../../src/infra/fusion/fusion-engine.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import { createFusionFixture, GPS_LAST, SPEED_KMH } from '../helpers/duckdb-fixture.js';
import {
  cleanupLapFixtures,
  fixturePaths,
  fixtureLogger,
  installSession,
  lapFixtureRoot,
} from './fixtures.js';

const SESSION = 'telemetry-stint-demo.duckdb';

/** Telemetry never downloads from Discord; the repository only needs the port to exist. */
const noDiscord: DiscordSessionGateway = {
  async getThreadAttachments() {
    return null;
  },
  async downloadFile() {
    /* unused */
  },
};

const factory = new DuckDbConnectionFactory();
const registry = new TrackRegistry(fixtureLogger);
const metadataReader = new MetadataReader(fixtureLogger);
const carCatalog = new CarCatalog();

let paths: AppPaths;
let lapService: LapService;
let service: TelemetryService;

/** `[frame count, first timestamp, last timestamp]` of a fused frame. */
function spanOf(frame: { time: Float64Array }): [number, number, number] {
  return [frame.time.length, frame.time[0], frame.time[frame.time.length - 1]];
}

beforeAll(async () => {
  paths = fixturePaths();
  lapService = new LapService(factory, metadataReader, registry, carCatalog, fixtureLogger);
  const sessionService = new SessionService(
    new SessionRepository(paths, noDiscord, fixtureLogger),
    lapService,
    registry,
    fixtureLogger,
  );
  const fusionEngine = new FusionEngine(factory, metadataReader, registry, carCatalog, fixtureLogger);
  service = new TelemetryService(sessionService, lapService, fusionEngine);

  // The shared fusion fixture, copied into the guest profile so `SessionService.resolve` finds it.
  const fixture = await createFusionFixture({
    dir: lapFixtureRoot(),
    databaseName: 'telemetry-source.duckdb',
  });
  await installSession(paths, 'guest', fixture.database, SESSION, 1_700_000_000);
});

afterAll(() => {
  cleanupLapFixtures();
});

describe('TelemetryService.load - frequency', () => {
  it('rejects the range the controller rejects, with the controller message', () => {
    expect(() => assertFrequency(1)).not.toThrow();
    expect(() => assertFrequency(1000)).not.toThrow();
    expect(() => assertFrequency(60)).not.toThrow();
    for (const invalid of [0, -1, 1001, Number.NaN, 10.5]) {
      expect(() => assertFrequency(invalid)).toThrow(ApiException);
      try {
        assertFrequency(invalid);
      } catch (error) {
        expect((error as ApiException).status).toBe(400);
        expect((error as ApiException).message).toBe('freq must be between 1 and 1000');
      }
    }
  });

  it('refuses an out-of-range frequency before touching the session file', async () => {
    const attempt = service.load('guest', SESSION, 0, null, null);
    await expect(attempt).rejects.toThrow('freq must be between 1 and 1000');
    await expect(service.load('guest', 'does-not-exist.duckdb', 5000)).rejects.toThrow(
      'freq must be between 1 and 1000',
    );
  });

  it('fuses the whole session when no trim parameter is given', async () => {
    const { frame } = await service.load('guest', SESSION, 10, null, null);
    expect(frame.frequency).toBe(10);
    expect(spanOf(frame)).toEqual([1201, 0, GPS_LAST]);
    // Java emits "Time" as the first channel of the LinkedHashMap, so it leads the payload.
    expect([...frame.channels.keys()][0]).toBe('Time');
    expect(frame.channels.size).toBeGreaterThan(20);
    expect(frame.channels.get('Ground Speed')?.data[5]).toBe(SPEED_KMH);
  });

  it('passes the requested frequency straight through to the engine', async () => {
    const at60 = await service.load('guest', SESSION, 60);
    expect(at60.frame.frequency).toBe(60);
    expect(at60.frame.time.length).toBe(7201);
    const at1 = await service.load('guest', SESSION, 1);
    expect(at1.frame.time.length).toBe(121);
  });
});

describe('TelemetryService.load - stint and lap trims', () => {
  it('trims a lap by its own start and end', async () => {
    const lap0 = await service.load('guest', SESSION, 10, null, 0);
    expect(spanOf(lap0.frame)).toEqual([301, 0, 30]);
    const lap1 = await service.load('guest', SESSION, 10, null, 1);
    expect(spanOf(lap1.frame)).toEqual([401, 30, 70]);
    const lap2 = await service.load('guest', SESSION, 10, null, 2);
    expect(spanOf(lap2.frame)).toEqual([501, 70, GPS_LAST]);
  });

  it('trims a stint to the envelope of all its laps', async () => {
    // Stint 1 holds lap 0 (0..30) and lap 1 (30..70): min start, max end.
    const stint1 = await service.load('guest', SESSION, 10, 1, null);
    expect(spanOf(stint1.frame)).toEqual([701, 0, 70]);
    // Stint 2 holds only lap 2 (70..120).
    const stint2 = await service.load('guest', SESSION, 10, 2, null);
    expect(spanOf(stint2.frame)).toEqual([501, 70, GPS_LAST]);
  });

  it('lets lap_id win over stint_id, like TelemetryService.java:34 does', async () => {
    const both = await service.load('guest', SESSION, 10, 2, 1);
    expect(spanOf(both.frame)).toEqual([401, 30, 70]);
  });

  it('answers 404 for an unknown lap or stint', async () => {
    await expect(service.load('guest', SESSION, 10, null, 6)).rejects.toMatchObject({
      status: 404,
      message: 'Lap 6 not found',
    });
    await expect(service.load('guest', SESSION, 10, 9, null)).rejects.toMatchObject({
      status: 404,
      message: 'Stint 9 not found',
    });
    // 0 is a real lap index, not "absent"; there is no stint 0 in this session.
    const lapZero = await service.load('guest', SESSION, 10, null, 0);
    expect(lapZero.frame.time.length).toBe(301);
    await expect(service.load('guest', SESSION, 10, 0, null)).rejects.toThrow('Stint 0 not found');
  });

  it('treats undefined the same as null for both parameters', async () => {
    const implicit = await service.load('guest', SESSION, 10);
    const explicit = await service.load('guest', SESSION, 10, null, null);
    expect(implicit.frame.time.length).toBe(explicit.frame.time.length);
  });
});

describe('TelemetryService.load - session resolution', () => {
  it('404s an unknown session', async () => {
    await expect(service.load('guest', 'nope.duckdb', 10)).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
    });
  });

  it('400s a path that escapes the profile directory', async () => {
    await expect(service.load('guest', '../escape.duckdb', 10)).rejects.toMatchObject({
      status: 400,
      message: 'Path escapes the data directory',
    });
    await expect(service.load('guest', 'C:\\Windows\\system.ini', 10)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('400s a file that is not a session database', async () => {
    await expect(service.load('guest', 'notes.txt', 10)).rejects.toMatchObject({
      status: 400,
      message: 'Only .duckdb files are supported',
    });
  });
});

describe('TelemetryService.load - suspension baselines', () => {
  it('falls back to the median because the fast session never passes the speed gate', async () => {
    const { frame, suspensionBaselines: baselines } = await service.load('guest', SESSION, 10);
    // Ground Speed is 216 (> 80), so the limit is 50 and no frame is "slow and straight":
    // every wheel count stays below 10 and the median of the constant samples wins.
    expect(baselines).toEqual(suspensionBaselines(frame));
    expect(baselines).toEqual([0.5, -0.5, 1.0, -1.5]);
  });

  it('returns four zeroes when the session has no suspension channel', () => {
    const frame = { frequency: 10, time: new Float64Array(0), channels: new Map() };
    expect(suspensionBaselines(frame)).toEqual([0.0, 0.0, 0.0, 0.0]);
  });

  it('returns four zeroes for a Susp Pos that is not a four-wheel channel', () => {
    const frame = { frequency: 10, time: new Float64Array(3), channels: new Map() };
    frame.channels.set('Susp Pos', Channel.scalar('Susp Pos', [1.0, 2.0, 3.0]));
    expect(suspensionBaselines(frame)).toEqual([0.0, 0.0, 0.0, 0.0]);
  });
});

describe('the whole telemetry chain', () => {
  it('streams one valid JSON document whose channels match the frame', async () => {
    const { frame, suspensionBaselines: baselines } = await service.load('guest', SESSION, 10, 1, null);
    const sink = memorySink();
    await writeTelemetryJson(sink, frame, baselines);

    expect(sink.chunks.length).toBeGreaterThan(1);
    const parsed = JSON.parse(sink.text()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...frame.channels.keys(), 'suspension_baselines']);
    expect(parsed['Time']).toHaveLength(frame.time.length);
    expect(parsed['suspension_baselines']).toEqual([0.5, -0.5, 1.0, -1.5]);
    expect((parsed['Ground Speed'] as number[])[0]).toBe(SPEED_KMH);

    // The literal that reaches the browser keeps Java's Double.toString spelling.
    expect(sink.text()).toContain('"Ground Speed":[216.0');
    expect(sink.text()).toContain('"suspension_baselines":[0.5,-0.5,1.0,-1.5]');
  });
});
