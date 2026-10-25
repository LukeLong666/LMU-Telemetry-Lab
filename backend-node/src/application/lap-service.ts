/**
 * Ports backend-java/src/main/java/com/lmutl/application/LapService.java (466 lines).
 *
 * Reads one session database and produces the lap list plus the session metadata the
 * frontend renders (`GET /api/v1/sessions/{id}/laps`, and through it `/reference-laps`).
 * Every rule the Java backend settled on is copied verbatim, not "improved":
 * - the `< 5.0s` interval skip (LapService.java:125) and the `lap = boundary index` numbering;
 * - `isValid` = a `Lap Time` event within 0.5s of the lap end (LapService.java:129-130, 298-305);
 * - out-lap = first boundary or the lap right after a pit lap (LapService.java:116, 147, 155);
 * - the sector null chain (LapService.java:132-143) and the `0.0 reading -> null` rule (317);
 * - the fuel clamp `max(0, startFuel - endFuel)` (LapService.java:332-341);
 * - stint counting, incremented after an in-pit lap (LapService.java:152-154);
 * - the distance fingerprint over the track layouts (LapService.java:224-254);
 * - the in-process header cache keyed on the database path, invalidated by mtime+size
 *   (LapService.java:44, 62-91, 464).
 *
 * Java -> TypeScript notes:
 * - `Connection` becomes the `DuckDBConnection` handed to `withConnection`'s callback; the
 *   connection lifecycle stays with `DuckDbConnectionFactory` (Java's try-with-resources).
 * - The injected Jackson `ObjectMapper` is replaced by `JSON.parse` plus the Jackson-shaped
 *   accessors at the bottom of this file; Jackson is not a dependency here.
 * - The static SLF4J logger becomes a constructor `Logger`, matching the other services.
 * - `IllegalStateException("Failed to read lap header: ...")` stays a plain `Error`: the
 *   global handler maps anything that is not an `ApiException` to 500 "Internal Server
 *   Error", exactly like Java's catch-all `@ExceptionHandler(Exception.class)`.
 * - Private static helpers keep their Java names; where a Java local shares one, the local
 *   is suffixed (`fuelCapacityValue`) because a `const` would otherwise shadow the function
 *   inside its own initializer (TDZ) - something Java's scoping never runs into.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  LapInfo,
  LapsResponse,
  SessionMetadata,
  TrackDefinition,
  TrackSectorPoint,
} from '../domain/types.js';
import { officialLength } from '../domain/types.js';
import type { CarCatalog } from '../infra/car/car-catalog.js';
import type { DuckDbConnectionFactory } from '../infra/duckdb/connection.js';
import { resolve as resolveLapBoundaries, type LapBoundaries } from '../infra/duckdb/lap-boundaries.js';
import * as DuckDbReads from '../infra/duckdb/reads.js';
import type { MetadataReader } from '../infra/duckdb/metadata.js';
import { isBlank } from '../infra/track/track-names.js';
import type { TrackRegistry } from '../infra/track/track-registry.js';
import type { Logger } from '../lib/log.js';

/** LapService.java:37 - `Pattern.compile("([\\d.]+)")` used through `find()`, i.e. first match. */
const FIRST_NUMBER = /[\d.]+/;

/** A valid lap that carries both sector splits - the precondition of the sector-point lookup. */
type SectorLap = LapInfo & { s1: number; s2: number };

/**
 * The caller-side dimensions of a header cache entry. Java keys the cache on the absolute
 * database path alone; the resolved path already sits inside the profile's `DuckDB_data`
 * directory, but the route layer knows `profile_id` + `session id` explicitly and can pass
 * them so the key carries all three dimensions. Omitting them (SessionService /
 * ReferenceLapService callers) keeps Java's path-only key.
 */
export interface LapCacheIdentity {
  readonly profileId?: string | null;
  readonly sessionId?: string | null;
}

/** LapService.java:464 - `record HeaderCache(LapsResponse response, long size, long modified)`. */
interface HeaderCacheEntry {
  readonly response: LapsResponse;
  readonly size: number;
  readonly modified: number;
}

export class LapService {
  /** LapService.java:44 - the `ConcurrentHashMap<Path, HeaderCache>`; Node runs single-threaded. */
  private readonly headerCache = new Map<string, HeaderCacheEntry>();

  constructor(
    private readonly connections: DuckDbConnectionFactory,
    private readonly metadataReader: MetadataReader,
    private readonly trackRegistry: TrackRegistry,
    private readonly carCatalog: CarCatalog,
    private readonly logger: Logger,
  ) {}

  /** LapService.java:58-60 - SessionService drops the cache on upload/rename/delete. */
  clearCache(): void {
    this.headerCache.clear();
  }

  /**
   * LapService.java:62-91. mtime+size are checked before the database is opened, so a
   * repeated `/laps` on an untouched file never touches DuckDB at all.
   */
  async header(database: string, identity?: LapCacheIdentity): Promise<LapsResponse> {
    // Java: database.toAbsolutePath().normalize()
    const resolved = path.resolve(database);
    const cacheKey = buildCacheKey(resolved, identity);
    const size = await fileSize(resolved);
    const modified = await lastModifiedMillis(resolved);

    const cached = this.headerCache.get(cacheKey);
    if (cached !== undefined && cached.size === size && cached.modified === modified) {
      return cached.response;
    }

    try {
      const response = await this.connections.withConnection(resolved, (session) =>
        this.readHeader(session.connection),
      );
      this.headerCache.set(cacheKey, { response, size, modified });
      return response;
    } catch (error) {
      this.logger.error({ err: error, database }, 'Failed to read lap header');
      throw new Error(`Failed to read lap header: ${messageOf(error)}`, { cause: error });
    }
  }

  /** LapService.java:72-84 - the body that runs while the connection is open. */
  private async readHeader(connection: DuckDBConnection): Promise<LapsResponse> {
    const boundaries = await resolveLapBoundaries(connection);
    const meta = await this.metadataReader.read(connection);

    const sector1 = await DuckDbReads.readEventsOrEmpty(connection, 'Last Sector1');
    const sector2 = await DuckDbReads.readEventsOrEmpty(connection, 'Last Sector2');
    const inPits = await DuckDbReads.readEventsOrEmpty(connection, 'In Pits');
    const gpsTimes = await DuckDbReads.readValuesOrEmpty(connection, 'GPS Time');
    const fuelValues = await DuckDbReads.readValuesOrEmpty(connection, 'Fuel Level');
    const fuelTimes = mapIndicesToTimes(gpsTimes, fuelValues.length);

    const laps = this.buildLaps(boundaries, sector1, sector2, inPits, fuelValues, fuelTimes);
    const metadata = await this.buildMetadata(connection, meta, boundaries, laps, gpsTimes);
    return { laps, metadata };
  }

  /** LapService.java:109-158. */
  private buildLaps(
    boundaries: LapBoundaries,
    sector1: DuckDbReads.Event[],
    sector2: DuckDbReads.Event[],
    inPits: DuckDbReads.Event[],
    fuelValues: Float64Array,
    fuelTimes: Float64Array,
  ): LapInfo[] {
    const laps: LapInfo[] = [];
    let lastAddedInPit = false;
    let stint = 1;

    for (let i = 0; i < boundaries.boundaries.length; i++) {
      const start = boundaries.boundaries[i];
      const end =
        i + 1 < boundaries.boundaries.length ? boundaries.boundaries[i + 1] : boundaries.sessionEnd;
      const rawDuration = end - start;
      if (rawDuration < 5.0) {
        continue;
      }

      const matched = matchedLapTime(boundaries.lapTimes, end);
      const duration = matched !== null ? matched : rawDuration;

      const s1Value = lastValue(sector1, end, start);
      const s2Value = lastValue(sector2, end, start);
      let s1: number | null = null;
      let s2: number | null = null;
      let s3: number | null = null;
      if (s1Value !== null) {
        s1 = s1Value;
        if (s2Value !== null) {
          s2 = s2Value - s1Value;
          s3 = duration - s2Value;
        }
      }

      const inPit = isInPit(inPits, start, end);
      const fuelUsedValue = fuelUsed(fuelValues, fuelTimes, start, end);
      const outLap = i === 0 || lastAddedInPit;

      laps.push({
        lap: i,
        startTime: start,
        endTime: end,
        duration,
        isValid: matched !== null,
        isOutLap: outLap,
        inPit,
        fuelUsed: fuelUsedValue,
        s1,
        s2,
        s3,
        stint,
      });

      if (inPit) {
        stint++;
      }
      lastAddedInPit = inPit;
    }
    return laps;
  }

  /** LapService.java:160-222. */
  private async buildMetadata(
    connection: DuckDBConnection,
    meta: Map<string, string | null>,
    boundaries: LapBoundaries,
    laps: LapInfo[],
    gpsTimes: Float64Array,
  ): Promise<SessionMetadata> {
    const rawTrack = this.metadataReader.value(meta, 'TrackName', 'Unknown Track');
    const rawLayout = this.metadataReader.value(meta, 'TrackLayout', '');
    const rawCar = this.metadataReader.value(meta, 'CarName', 'Unknown Car');
    const rawClass = this.metadataReader.value(meta, 'CarClass', 'Unknown Class');
    const driver = this.metadataReader.value(meta, 'DriverName', 'Unknown Driver');
    const sessionTime = this.metadataReader.value(meta, 'SessionTime', 'Unknown Time');
    const sessionType = this.metadataReader.value(meta, 'SessionType', 'Unknown Session');
    const weather = this.metadataReader.value(meta, 'WeatherConditions', 'Unknown Weather');

    const setup = this.parseJson(meta.get('CarSetup') ?? null);
    const config = this.parseJson(meta.get('CarConfig') ?? null);

    const fuelCapacityValue = fuelCapacity(config, setup);
    const tyreCompoundMaxValue = tyreCompoundMax(config, setup);
    const steeringLockString =
      setup === null ? null : text(pathOf(setup, 'VM_STEER_LOCK'), 'stringValue');
    const steeringLock = this.carCatalog.parseSteerLock(steeringLockString);

    // LapService.java:183 uses the THREE-argument form: the setup override must also apply
    // when the car name hits the seeded mapping (the CarCatalog bug noted in PORTING_LOG).
    const car = this.carCatalog.getCarInfo(rawCar, rawClass, steeringLock);
    const trackMatch = this.trackRegistry.findTrack(rawTrack);
    const track = trackMatch === null ? null : trackMatch.definition;
    const layoutMatch =
      track === null || trackMatch === null
        ? null
        : this.trackRegistry.findLayout(track, rawLayout, trackMatch.key);

    const layoutKey = layoutMatch === null ? emptyToNull(rawLayout) : layoutMatch.key;
    let officialLengthValue =
      layoutMatch === null || layoutMatch.layout === null ? null : officialLength(layoutMatch.layout);

    officialLengthValue = await this.applyDistanceFingerprint(connection, track, officialLengthValue);

    const sectorPoints = await this.buildSectorPoints(connection, laps, gpsTimes);

    // Key order == SessionMetadata's record component order == the JSON field order.
    return {
      trackName: rawTrack,
      commonTrackName: trackMatch === null ? rawTrack : trackMatch.key,
      trackAliases: track === null ? [] : track.aliases,
      country: track === null ? '' : nullToEmpty(track.country),
      trackLayout: rawLayout,
      layoutKey,
      officialTrackLength: officialLengthValue,
      carClass: rawClass,
      modelName: car.modelName,
      rawCarName: rawCar,
      driverName: driver,
      sessionTime,
      sessionDuration: boundaries.sessionEnd - boundaries.sessionStart,
      sessionType,
      weather,
      trackSectors: sectorPoints,
      fuelCapacity: fuelCapacityValue,
      tyreCompoundMax: tyreCompoundMaxValue,
      steeringLock,
      steeringLockString,
    };
  }

  /** LapService.java:224-254 - snap the official length to the layout the distance data fits. */
  private async applyDistanceFingerprint(
    connection: DuckDBConnection,
    track: TrackDefinition | null,
    officialLengthValue: number | null,
  ): Promise<number | null> {
    if (track === null) {
      return officialLengthValue;
    }
    const maxDistance = await DuckDbReads.scalarDouble(connection, 'SELECT MAX(value) FROM "Lap Dist"');
    if (maxDistance === null || maxDistance <= 500.0) {
      return officialLengthValue;
    }
    const current = officialLengthValue === null ? maxDistance : officialLengthValue;
    const ratio = current > 0 ? maxDistance / current : 0.0;
    if (officialLengthValue !== null && ratio >= 0.8 && ratio <= 1.2) {
      return officialLengthValue;
    }

    let bestLength = current;
    let minDiff = Math.abs(maxDistance - current);
    // Java iterates `track.layouts().values()` (a `Map.copyOf`, order unspecified - the
    // deviation documented in PORTING_LOG); JSON declaration order is deterministic here.
    for (const layout of Object.values(track.layouts ?? {})) {
      if (layout.ref_points.length === 0) {
        continue;
      }
      const length = officialLength(layout);
      const diff = Math.abs(maxDistance - length);
      if (diff < minDiff) {
        minDiff = diff;
        bestLength = length;
      }
    }
    return bestLength;
  }

  /** LapService.java:256-279 - sector 1/2 crossing coordinates of the shortest valid lap. */
  private async buildSectorPoints(
    connection: DuckDBConnection,
    laps: LapInfo[],
    gpsTimes: Float64Array,
  ): Promise<TrackSectorPoint[]> {
    // Java: laps.stream().filter(isValid && s1 != null && s2 != null).sorted(comparingDouble(duration))
    const valid = laps
      .filter((lap): lap is SectorLap => lap.isValid && lap.s1 !== null && lap.s2 !== null)
      .sort((left, right) => doubleCompare(left.duration, right.duration));
    if (valid.length === 0 || gpsTimes.length === 0) {
      return [];
    }
    const best = valid[0];
    const t1 = best.startTime + best.s1;
    const t2 = best.startTime + best.s1 + best.s2;

    const latitudes = await DuckDbReads.readValuesOrEmpty(connection, 'GPS Latitude');
    const longitudes = await DuckDbReads.readValuesOrEmpty(connection, 'GPS Longitude');
    if (latitudes.length === 0 || longitudes.length === 0) {
      return [];
    }

    const points: TrackSectorPoint[] = [];
    addSectorPoint(points, gpsTimes, latitudes, longitudes, t1, 1);
    addSectorPoint(points, gpsTimes, latitudes, longitudes, t2, 2);
    return points;
  }

  /** LapService.java:380-390 - blank or unparseable setup/config JSON simply means "no JSON". */
  private parseJson(raw: string | null | undefined): unknown {
    if (raw === null || raw === undefined || isBlank(raw)) {
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      this.logger.warn(`Failed to parse metadata JSON: ${messageOf(error)}`);
      return null;
    }
  }
}

/** LapService.java:298-305 - the first `Lap Time` event within 0.5s of the lap end. */
function matchedLapTime(lapTimes: DuckDbReads.Event[], end: number): number | null {
  for (const event of lapTimes) {
    if (Math.abs(event.ts - end) < 0.5) {
      return event.value;
    }
  }
  return null;
}

/** LapService.java:307-318 - last event in `(minTime, queryTime]`; a 0.0 reading means absent. */
function lastValue(events: DuckDbReads.Event[], queryTime: number, minTime: number): number | null {
  let value: number | null = null;
  for (const event of events) {
    if (event.ts > queryTime) {
      break;
    }
    if (event.ts > minTime) {
      value = event.value;
    }
  }
  return value === null || value === 0.0 ? null : value;
}

/** LapService.java:320-330 - the first positive `In Pits` reading in `[start, end)`. */
function isInPit(events: DuckDbReads.Event[], start: number, end: number): boolean {
  for (const event of events) {
    if (event.ts >= end) {
      break;
    }
    if (event.ts >= start && event.value > 0.5) {
      return true;
    }
  }
  return false;
}

/** LapService.java:332-341. */
function fuelUsed(
  fuelValues: Float64Array,
  fuelTimes: Float64Array,
  start: number,
  end: number,
): number {
  if (fuelValues.length === 0 || fuelTimes.length === 0) {
    return 0.0;
  }
  const startIndex = lowerBound(fuelTimes, start);
  const endIndex = lowerBound(fuelTimes, end);
  const startFuel = startIndex < fuelValues.length ? fuelValues[startIndex] : 0.0;
  const endFuel = endIndex > 0 && endIndex <= fuelValues.length ? fuelValues[endIndex - 1] : 0.0;
  return Math.max(0.0, startFuel - endFuel);
}

/** LapService.java:343-364 - resample the GPS time axis onto a channel's sample axis. */
function mapIndicesToTimes(gpsTimes: Float64Array, sampleCount: number): Float64Array {
  if (sampleCount === 0 || gpsTimes.length === 0) {
    return new Float64Array(0);
  }
  const times = new Float64Array(sampleCount);
  if (sampleCount === 1 || gpsTimes.length === 1) {
    times[0] = gpsTimes[0];
    return times;
  }
  const step = (gpsTimes.length - 1) / (sampleCount - 1);
  for (let i = 0; i < sampleCount; i++) {
    const position = i * step;
    const index = Math.floor(position);
    if (index >= gpsTimes.length - 1) {
      times[i] = gpsTimes[gpsTimes.length - 1];
    } else {
      const fraction = position - index;
      times[i] = gpsTimes[index] + fraction * (gpsTimes[index + 1] - gpsTimes[index]);
    }
  }
  return times;
}

/** LapService.java:366-378 - first index whose value is >= target (`(low + high) >>> 1`). */
export function lowerBound(values: Float64Array | readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** LapService.java:281-296. */
function addSectorPoint(
  points: TrackSectorPoint[],
  gpsTimes: Float64Array,
  latitudes: Float64Array,
  longitudes: Float64Array,
  targetTime: number,
  id: number,
): void {
  const index = lowerBound(gpsTimes, targetTime);
  if (index >= gpsTimes.length || index >= latitudes.length || index >= longitudes.length) {
    return;
  }
  const lat = latitudes[index];
  const lon = longitudes[index];
  if (!Number.isNaN(lat) && !Number.isNaN(lon) && lat !== 0.0 && lon !== 0.0) {
    points.push({ lat, lon, id });
  }
}

/** LapService.java:392-411 - `CarConfig.fuelCapacity` wins; otherwise read the setup entry. */
function fuelCapacity(config: unknown, setup: unknown): number {
  if (config !== null) {
    return asDouble(pathOf(config, 'fuelCapacity'), 0.0);
  }
  if (setup !== null) {
    const node = pathOf(setup, 'VM_FUEL_CAPACITY');
    if (isObjectNode(node)) {
      // LapService.java:399 - `stringValue`, else `lastSavedStringValue`, else "".
      const stringValue = asText(
        pathOf(node, 'stringValue'),
        asText(pathOf(node, 'lastSavedStringValue'), ''),
      );
      const parsed = firstNumber(stringValue);
      if (parsed !== null) {
        return parsed;
      }
      const value = asDouble(pathOf(node, 'value'), 0.0);
      if (value > 0) {
        return value;
      }
    }
  }
  return 0.0;
}

/** LapService.java:413-426 - only meaningful when there is no `CarConfig`. */
function tyreCompoundMax(config: unknown, setup: unknown): number {
  if (config !== null || setup === null) {
    return 0;
  }
  const front = pathOf(setup, 'VM_FRONT_TIRE_COMPOUND');
  if (isObjectNode(front)) {
    return asInt(pathOf(front, 'maxValue'), 0);
  }
  const rear = pathOf(setup, 'VM_REAR_TIRE_COMPOUND');
  if (isObjectNode(rear)) {
    return asInt(pathOf(rear, 'maxValue'), 0);
  }
  return 0;
}

/** LapService.java:428-441. */
function firstNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const match = FIRST_NUMBER.exec(value);
  if (match === null) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isNaN(parsed) ? null : parsed;
}

/** LapService.java:443-449 - the `VM_*` entry has to be an object to carry a string value. */
function text(node: unknown, field: string): string | null {
  if (!isObjectNode(node)) {
    return null;
  }
  const value = asText(pathOf(node, field), null);
  return value === null || isBlank(value) ? null : value;
}

/** LapService.java:456-458. */
function emptyToNull(value: string | null): string | null {
  return value === null || isBlank(value) ? null : value;
}

/** LapService.java:460-462. */
function nullToEmpty(value: string | null): string {
  return value === null ? '' : value;
}

/** Java's `Double.compare`: NaN sorts last, -0.0 sorts before 0.0. */
function doubleCompare(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  if (left === 0 && right === 0) {
    const leftNegativeZero = Object.is(left, -0);
    const rightNegativeZero = Object.is(right, -0);
    if (leftNegativeZero === rightNegativeZero) return 0;
    return leftNegativeZero ? -1 : 1;
  }
  return 0;
}

// --- Jackson JsonNode equivalents: path() / isObject() / asText() / asDouble() / asInt() ----

function isObjectNode(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

/** `JsonNode.path(name)`; on anything but an object Jackson hands back MissingNode (undefined). */
function pathOf(node: unknown, key: string): unknown {
  return isObjectNode(node) ? node[key] : undefined;
}

/** `JsonNode.asDouble(default)`. */
function asDouble(node: unknown, fallback: number): number {
  if (typeof node === 'number') {
    return node;
  }
  if (typeof node === 'boolean') {
    return node ? 1 : 0;
  }
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed === '') {
      return fallback;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

/** `JsonNode.asInt(default)` - Jackson narrows doubles toward zero. */
function asInt(node: unknown, fallback: number): number {
  if (typeof node === 'number') {
    return Number.isNaN(node) ? fallback : Math.trunc(node);
  }
  if (typeof node === 'boolean') {
    return node ? 1 : 0;
  }
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return fallback;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** `JsonNode.asText(default)` - missing nodes and containers take the default. */
function asText(node: unknown, fallback: string | null): string | null {
  if (node === undefined || node === null) {
    return fallback;
  }
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  return fallback;
}

function buildCacheKey(resolved: string, identity?: LapCacheIdentity): string {
  const profileId = identity?.profileId ?? '';
  const sessionId = identity?.sessionId ?? '';
  return `${profileId}\u0000${sessionId}\u0000${resolved}`;
}

async function fileSize(target: string): Promise<number> {
  try {
    return (await fs.promises.stat(target)).size;
  } catch {
    return 0;
  }
}

async function lastModifiedMillis(target: string): Promise<number> {
  try {
    // Java's `FileTime.toMillis()` is integral; mtimeMs can carry a sub-millisecond fraction.
    return Math.trunc((await fs.promises.stat(target)).mtimeMs);
  } catch {
    return 0;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
