import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LapService, lowerBound } from '../../src/application/lap-service.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import {
  DuckDbConnectionFactory,
  type DuckDbSession,
} from '../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../src/infra/duckdb/metadata.js';
import { TrackRegistry } from '../../src/infra/track/track-registry.js';
import {
  BARE_SESSION_SQL,
  FINGERPRINT_SESSION_SQL,
  MAIN_SESSION_SQL,
  SETUP_FALLBACKS_SESSION_SQL,
  UNKNOWN_TRACK_SESSION_SQL,
  buildSessionDatabase,
  cleanupLapFixtures,
  fixtureLogger,
} from './fixtures.js';

/** Opens are counted so the header cache's hit/miss behaviour is observable. */
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

const factory = new DuckDbConnectionFactory();

function createService(connections: DuckDbConnectionFactory = factory): LapService {
  return new LapService(
    connections,
    new MetadataReader(fixtureLogger),
    new TrackRegistry(fixtureLogger),
    new CarCatalog(),
    fixtureLogger,
  );
}

let mainDb = '';
let bareDb = '';
let fingerprintDb = '';
let setupFallbacksDb = '';
let unknownTrackDb = '';

beforeAll(async () => {
  mainDb = await buildSessionDatabase('main-session.duckdb', MAIN_SESSION_SQL);
  bareDb = await buildSessionDatabase('bare-session.duckdb', BARE_SESSION_SQL);
  fingerprintDb = await buildSessionDatabase('fingerprint-session.duckdb', FINGERPRINT_SESSION_SQL);
  setupFallbacksDb = await buildSessionDatabase('setup-fallbacks-session.duckdb', SETUP_FALLBACKS_SESSION_SQL);
  unknownTrackDb = await buildSessionDatabase('unknown-track-session.duckdb', UNKNOWN_TRACK_SESSION_SQL);
}, 180_000);

afterAll(() => {
  cleanupLapFixtures();
});

describe('LapService.header laps', () => {
  it('reproduces the Java lap rules row by row', async () => {
    const service = createService();
    const response = await service.header(mainDb);

    expect(response.laps).toEqual([
      {
        lap: 0,
        startTime: 90,
        endTime: 100,
        duration: 10,
        isValid: false,
        isOutLap: true,
        inPit: false,
        fuelUsed: 0.5,
        // an event exactly at the lap end still counts (only `ts > end` stops the scan),
        // and it is the last reading in the window, so 77.0 wins over 4.5.
        s1: 77.0,
        s2: null,
        s3: null,
        stint: 1,
      },
      {
        lap: 1,
        startTime: 100,
        endTime: 130,
        duration: 30.25,
        isValid: true,
        isOutLap: false,
        inPit: false,
        fuelUsed: 2.5,
        s1: 12.0,
        s2: 8.0,
        s3: 10.25,
        stint: 1,
      },
      {
        lap: 2,
        startTime: 130,
        endTime: 160,
        duration: 28.5,
        isValid: true,
        isOutLap: false,
        inPit: true,
        fuelUsed: 2.5,
        s1: 11.5,
        s2: 7.5,
        s3: 9.5,
        stint: 1,
      },
      {
        // the 160 -> 162 interval is < 5s and is skipped, so the lap index jumps to 4:
        // `lap` is the boundary index, not a running counter.
        lap: 4,
        startTime: 162,
        endTime: 190,
        // the Lap Time event at 190 reads 0.0, so the resolver drops it: raw duration, invalid.
        duration: 28,
        isValid: false,
        // first boundary OR the lap right after an in-pit lap.
        isOutLap: true,
        // the 180 reading is false, and 219.9 is past this lap's end (break before check).
        inPit: false,
        fuelUsed: 2.0,
        // sector2 reads 0.0, which LapService treats as "absent" -> s2/s3 null.
        s1: 13.0,
        s2: null,
        s3: null,
        stint: 2,
      },
      {
        lap: 5,
        startTime: 190,
        endTime: 220,
        duration: 29.75,
        isValid: true,
        isOutLap: false,
        inPit: true,
        fuelUsed: 2.5,
        // a sector2 reading without a sector1 reading leaves all three null.
        s1: null,
        s2: null,
        s3: null,
        stint: 2,
      },
      {
        lap: 6,
        startTime: 220,
        endTime: 250,
        duration: 31.5,
        isValid: true,
        isOutLap: true,
        // an `In Pits` reading exactly at the lap start is inside [start, end).
        inPit: true,
        // the refuel between the two samples would be negative; Java clamps with max(0, ...).
        fuelUsed: 0,
        s1: 12.5,
        s2: 8.5,
        s3: 10.5,
        stint: 3,
      },
    ]);
  });

  it('keeps the sector split arithmetic of the Java version', async () => {
    const service = createService();
    const response = await service.header(mainDb);
    const lap1 = response.laps[1];
    const sector1 = 12.0;
    const sector2Raw = 20.0;
    // s2 = sector2Raw - sector1, s3 = duration - sector2Raw (LapService.java:140-141).
    expect(lap1.s1).toBe(sector1);
    expect(lap1.s2).toBe(sector2Raw - sector1);
    expect(lap1.s3).toBe(lap1.duration - sector2Raw);
    expect((lap1.s1 as number) + (lap1.s2 as number) + (lap1.s3 as number)).toBe(lap1.duration);
  });

  it('builds metadata from the registry, the car catalog and the setup json', async () => {
    const service = createService();
    const response = await service.header(mainDb);

    expect(response.metadata).toEqual({
      trackName: 'Sebring International Raceway',
      commonTrackName: 'Sebring International Raceway',
      trackAliases: ['Sebring'],
      country: 'United States',
      trackLayout: 'Default',
      layoutKey: 'Default',
      // Lap Dist peaks at 6000 against the official 6019: ratio 0.997 stays inside 0.8..1.2.
      officialTrackLength: 6019,
      carClass: 'LMGT3',
      // the seeded "united autosports" mapping still takes the setup's steer-lock override.
      modelName: 'McLaren 720S GT3 Evo',
      rawCarName: 'United Autosports McLaren 720S GT3 Evo',
      driverName: 'A. Driver',
      sessionTime: '2026-10-25 18:00:00',
      sessionDuration: 160,
      sessionType: 'Race',
      weather: 'Light Rain',
      trackSectors: [
        // best valid lap with both sectors = lap 2 (28.5s): t1 = 130 + 11.5 = 141.5,
        // t2 = 141.5 + 7.5 = 149. GPS Time[i] = 90 + 0.5i -> i = 103 and i = 118.
        { lat: 143, lon: 123, id: 1 },
        { lat: 158, lon: 138, id: 2 },
      ],
      fuelCapacity: 70,
      tyreCompoundMax: 4,
      steeringLock: 520,
      steeringLockString: '520 degrees',
    });
  });

  it('snaps the official length to the layout the distance data fits', async () => {
    const service = createService();
    const response = await service.header(fingerprintDb);

    expect(response.metadata.layoutKey).toBe('Default');
    expect(response.metadata.officialTrackLength).toBe(3219);
    expect(response.laps).toEqual([]);
    expect(response.metadata.trackSectors).toEqual([]);
    // CarConfig wins over the setup, and its presence forces tyreCompoundMax to 0.
    expect(response.metadata.fuelCapacity).toBe(80.5);
    expect(response.metadata.tyreCompoundMax).toBe(0);
    expect(response.metadata.steeringLock).toBe(480);
    expect(response.metadata.modelName).toBe('Oreca 07 Gibson');
  });

  it('falls back to the setup json chain when config and front tyres are missing', async () => {
    const service = createService();
    const response = await service.header(setupFallbacksDb);

    // No "Lap Dist" table -> scalarDouble null -> the official length is left untouched.
    expect(response.metadata.officialTrackLength).toBe(3219);
    expect(response.metadata.layoutKey).toBe('School Circuit');
    // VM_FUEL_CAPACITY only carries lastSavedStringValue.
    expect(response.metadata.fuelCapacity).toBe(62.5);
    // VM_FRONT_TIRE_COMPOUND missing -> the rear entry's maxValue.
    expect(response.metadata.tyreCompoundMax).toBe(3);
    // a blank stringValue is no steer lock at all.
    expect(response.metadata.steeringLock).toBeNull();
    expect(response.metadata.steeringLockString).toBeNull();
    expect(response.metadata.trackSectors).toEqual([]);
  });

  it('keeps every Java metadata fallback when nothing matches', async () => {
    const service = createService();
    const response = await service.header(unknownTrackDb);

    expect(response.metadata).toEqual({
      trackName: 'Neverland Street Circuit',
      commonTrackName: 'Neverland Street Circuit',
      trackAliases: [],
      country: '',
      trackLayout: '',
      layoutKey: null,
      officialTrackLength: null,
      carClass: 'Unknown Class',
      modelName: 'Unknown Car',
      rawCarName: 'Unknown Car',
      driverName: 'Unknown Driver',
      sessionTime: 'Unknown Time',
      sessionDuration: 10,
      sessionType: 'Unknown Session',
      weather: 'Unknown Weather',
      trackSectors: [],
      fuelCapacity: 0,
      tyreCompoundMax: 0,
      steeringLock: null,
      steeringLockString: null,
    });
  });

  it('reads a session without metadata, sectors, pits or fuel', async () => {
    const service = createService();
    const response = await service.header(bareDb);

    expect(response.laps).toEqual([
      {
        lap: 0,
        startTime: 0,
        endTime: 10,
        duration: 10,
        isValid: false,
        isOutLap: true,
        inPit: false,
        fuelUsed: 0,
        s1: null,
        s2: null,
        s3: null,
        stint: 1,
      },
    ]);
    expect(response.metadata.trackName).toBe('Unknown Track');
    expect(response.metadata.trackSectors).toEqual([]);
    expect(response.metadata.fuelCapacity).toBe(0);
    expect(response.metadata.tyreCompoundMax).toBe(0);
    expect(response.metadata.steeringLock).toBeNull();
    expect(response.metadata.steeringLockString).toBeNull();
    expect(response.metadata.officialTrackLength).toBeNull();
    expect(response.metadata.country).toBe('');
    expect(response.metadata.trackAliases).toEqual([]);
  });

  it('wraps a read failure the way Java does', async () => {
    const service = createService();
    const missing = path.join(path.dirname(mainDb), 'does-not-exist.duckdb');

    await expect(service.header(missing)).rejects.toThrow(/^Failed to read lap header: /);
  });
});

describe('LapService header cache', () => {
  it('serves the cached response while mtime and size are unchanged', async () => {
    const connections = new CountingConnectionFactory();
    const service = createService(connections);

    const first = await service.header(bareDb);
    const second = await service.header(bareDb);

    expect(connections.opens).toBe(1);
    // Java hands back the very same LapsResponse instance from the cache.
    expect(second).toBe(first);
  });

  it('keys the cache on profile and session as well as the resolved path', async () => {
    const connections = new CountingConnectionFactory();
    const service = createService(connections);

    const anonymous = await service.header(bareDb);
    const asGuest = await service.header(bareDb, { profileId: 'guest', sessionId: 'bare.duckdb' });
    const asOtherProfile = await service.header(bareDb, { profileId: 'other', sessionId: 'bare.duckdb' });
    const sameIdentityAgain = await service.header(bareDb, { profileId: 'guest', sessionId: 'bare.duckdb' });

    expect(connections.opens).toBe(3);
    expect(asGuest).not.toBe(anonymous);
    expect(asOtherProfile).not.toBe(asGuest);
    expect(sameIdentityAgain).toBe(asGuest);
  });

  it('drops the entry when the file changes and on clearCache()', async () => {
    const connections = new CountingConnectionFactory();
    const service = createService(connections);

    const first = await service.header(bareDb);
    expect(connections.opens).toBe(1);

    const stat = await fs.promises.stat(bareDb);
    const future = new Date(stat.mtimeMs + 60_000);
    await fs.promises.utimes(bareDb, future, future);

    const afterTouch = await service.header(bareDb);
    expect(connections.opens).toBe(2);
    expect(afterTouch).not.toBe(first);

    service.clearCache();
    await service.header(bareDb);
    expect(connections.opens).toBe(3);
  });
});

describe('lowerBound', () => {
  it('matches Java\'s first-index-at-or-after semantics', () => {
    const values = [10, 20, 30];
    expect(lowerBound(values, 5)).toBe(0);
    expect(lowerBound(values, 10)).toBe(0);
    expect(lowerBound(values, 15)).toBe(1);
    expect(lowerBound(values, 30)).toBe(2);
    expect(lowerBound(values, 35)).toBe(3);
    expect(lowerBound(new Float64Array(0), 1)).toBe(0);
  });
});
