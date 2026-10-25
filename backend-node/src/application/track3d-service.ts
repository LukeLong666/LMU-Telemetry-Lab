/**
 * Port of backend-java/src/main/java/com/lmutl/application/Track3DService.java (413 lines).
 *
 * The service layer behind `GET /api/v1/sessions/{sessionId}/3d-track`: it feeds the frontend's
 * three.js view. Two fused frames are produced per request - a **base map** (the track outline,
 * taken from one reference lap of the stint) and a **racing line** (the selected lap) - both
 * projected onto a flat metre grid with a hand-written equirectangular projection (no geo
 * library, same as Java), and the racing line's elevation is *snapped* to the nearest base-map
 * point so the car rides the track mesh instead of floating over it.
 *
 * The three rules STATUS.md:52-55 records as settled are reproduced verbatim, not re-derived:
 *
 * 1. **Shortest valid lap as the base map** (Track3DService.java:57-78). Within the *selected*
 *    lap's stint: `valid && !outLap` laps first, minimum duration wins (`Stream.min` keeps the
 *    FIRST minimum, so a strict `<` scan below is the same thing); when that pool is empty the
 *    longest stint lap is used (`max`, which on ties also keeps the first), and a winner below
 *    5.0 s is discarded in favour of the selected lap itself. `fastestLap` in the response is
 *    this lap's number, and it - not the selected lap - also drives the sector lines
 *    (`buildSectors(..., best)`).
 * 2. **Stint anchoring** (Track3DService.java:57-63, 79-80). `firstLap` / `lastLap` are decided
 *    against `min(startTime)` / `max(endTime)` of the stint with a 5 s tolerance, and a flagged
 *    lap extends the racing-line window to the stint edge. Because laps shorter than 5 s are
 *    dropped by `LapService`, that extension is only reachable for a stint lap that starts or
 *    ends exactly 5.0 s inside the stint - the rule is still kept in full.
 * 3. **Elevation `zBase` + nearest-point Z snapping with a uniform grid**
 *    (Track3DService.java:98-103, 351-412). `zBase = min(WorldPosZ)` over the *base* frames,
 *    and every emitted z is `value - zBase`. The snapping uses a 20.0 m-cell grid (a `static
 *    final double CELL`, not bounding-box derived), rings searched radius 0..6 with the
 *    within-ring order `-radius..radius` on both axes, `distance < bestDistance` (strict, so the
 *    lowest index wins a tie), and a full linear scan as the fallback when no ring produced a
 *    candidate. Two Java quirks are load-bearing behaviour and are ported as-is rather than
 *    "fixed": the lookup feeds the *cell index* back into `key()`, which divides by `CELL` a
 *    second time (so a ring probes collapsed buckets), and the build/lookup keys are folded into
 *    one `long` with `(cellX << 32) ^ (cellY & 0xffffffffL)`.
 * 4. **4000-point downsampling** (Track3DService.java:25, 181-205). `step = max(1, length /
 *    TARGET_POINTS)` with *integer* division: it is a divisor, not a cap - a 9 001-frame lap
 *    samples every 2nd frame and returns 4 501 points (> 4000). The walk starts at index 0, so
 *    the first frame is always kept; the last frame is kept only when `(length - 1) % step === 0`
 *    (nothing is appended afterwards) - both exactly as Java.
 *
 * Field mapping oddity, kept deliberately: `Track3DPoint.lat` carries the **`Path Lateral`**
 * channel (the lateral offset in metres), while the real GPS position goes out as `raw_lat` /
 * `raw_lon` (Track3DService.java:197-201). `width` falls back to 7.5 m when the session has no
 * `Track Edge` channel; every other channel falls back to 0.0 (`valueAt`).
 *
 * Java -> TypeScript notes:
 * - `Path` becomes the string from `SessionService.resolve`, `Integer stint` becomes
 *   `number | null | undefined` (0 is a real stint, so `??` must not be used for the absent
 *   case), and `HttpStatus.NOT_FOUND` becomes `ApiException(404, 'Lap not found')` - the
 *   `lap < 0` -> 400 guard stays in the controller (Track3DController.java:29-31).
 * - `lapService.header(database)` is called WITHOUT a cache identity, exactly like Java
 *   (Track3DService.java:42): the key is the resolved path alone (see the note in
 *   telemetry-service.ts about the same choice).
 * - target frequency is **100 Hz** with the trim window as raw lap times (no pre-clamping; the
 *   fusion engine clamps into the session and has its own inverted-window fallback).
 * - Both `fuse` calls run sequentially, like Java, so the second one reuses the engine's
 *   connection handling instead of opening two DuckDB handles at once.
 * - `double[]` becomes `Float64Array` everywhere (fixed length, no holes, NaN instead of a
 *   silent `undefined` read).
 * - The `(int)` / `(long)` narrowing casts become `toJavaInt` / `Math.floor`+`Math.trunc`: Java
 *   narrows toward zero, maps NaN to 0 and the infinities to the int bounds. No `javaRound`
 *   helper is needed - this service has no `Math.round` call anywhere (unlike the fusion engine).
 * - `Math.floorMod` keeps Java's positive-modulo for the sector window indices.
 * - `Double.compare` ordering is used for the min/max duration scan, because
 *   `Comparator.comparingDouble` puts NaN last while a bare `<` never selects it.
 * - Every transcendental call (`Math.cos`, `Math.hypot`, and the `Math.toRadians` arithmetic) is
 *   issued once, in the same expression shape as Java, but V8 and the JVM are only required to
 *   agree within half an ULP: the output is numerically equivalent, not bit-identical.
 * - `mean` is imported from `infra/fusion/fusion-math.js` (identical to Java's private helper);
 *   Java's unused third `empty(...)` argument (the failed extraction, never read) is dropped.
 */
import { ApiException } from '../api/error.js';
import type {
  FusedFrame,
  LapInfo,
  LapsResponse,
  Track3DCenter,
  Track3DPoint,
  Track3DResponse,
  Track3DSectorPoint,
} from '../domain/types.js';
import { scalarChannel } from '../domain/types.js';
import { FusionEngine } from '../infra/fusion/fusion-engine.js';
import { FusionOptions } from '../infra/fusion/fusion-options.js';
import { mean } from '../infra/fusion/fusion-math.js';
import type { LapService } from './lap-service.js';
import type { SessionService } from './session-service.js';

/** Track3DService.java:25 - the downsampling divisor, not a hard cap (see the header note 4). */
const TARGET_POINTS = 4000;
/** Track3DService.java:26 - metres per degree of latitude; longitude gets scaled by cos(lat). */
const DEG_TO_M = 111320.0;
/** Track3DService.java:353 - `NearestIndex.CELL`, a fixed 20 m grid (never bounding-box derived). */
const CELL = 20.0;
/** Track3DService.java:369 - rings probed before the linear-scan fallback. */
const MAX_SEARCH_RADIUS = 6;
/** Track3DService.java:229 - +/- 5 frames around a sector marker give the tangent direction. */
const SECTOR_WINDOW = 5;
/** Track3DService.java:62-63 - the tolerance that decides "this lap anchors the stint". */
const STINT_ANCHOR_SECONDS = 5.0;
/** Track3DService.java:73 - a reference lap below this is too short to be the base map. */
const MIN_BASE_LAP_DURATION = 5.0;
/** Track3DService.java:172 - `valueAt(width, i, 7.5)`: half of a 15 m track, i.e. centre line. */
const DEFAULT_TRACK_WIDTH = 7.5;
/** Track3DService.java:77-82 - the 3D view always fuses at 100 Hz (the charts use their own freq). */
const TARGET_FREQUENCY = 100;

/** Track3DService.java:319-345 - `Extracted`, the valid-coordinate-compacted channel set. */
interface Extracted {
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly d: Float64Array;
  readonly speed: Float64Array;
  readonly throttle: Float64Array;
  readonly brake: Float64Array;
  readonly lateral: Float64Array;
  readonly width: Float64Array;
  readonly inPits: Float64Array;
  readonly z: Float64Array;
  readonly time: Float64Array;
}

export class Track3DService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly lapService: LapService,
    private readonly fusionEngine: FusionEngine,
  ) {}

  /**
   * Track3DService.java:40-122. `stint` is Java's nullable `Integer`: `null` / `undefined` mean
   * "not filtered", `0` is a real stint.
   */
  async build(
    profileId: string | null | undefined,
    sessionId: string | null,
    lapNumber: number,
    stint?: number | null,
  ): Promise<Track3DResponse> {
    const database = await this.sessionService.resolve(profileId, sessionId);
    const header = await this.lapService.header(database);
    const laps = header.laps;

    let selected: LapInfo | null = null;
    for (const lap of laps) {
      if (lap.lap === lapNumber && (stint === null || stint === undefined || lap.stint === stint)) {
        selected = lap;
        break;
      }
    }
    if (selected === null && lapNumber >= 0 && lapNumber < laps.length) {
      // Java's fallback indexes the list directly, so a lap-number/stint mismatch still renders
      // the lap at that position (the lap numbers LapService assigns are the boundary index).
      selected = laps[lapNumber];
    }
    if (selected === null) {
      throw new ApiException(404, 'Lap not found');
    }
    const chosen = selected;

    // -- rule 2: stint anchoring (Track3DService.java:57-63).
    const stintLaps = laps.filter((lap) => lap.stint === chosen.stint);
    const stintStart = lowest(
      stintLaps.map((lap) => lap.startTime),
      chosen.startTime,
    );
    const stintEnd = highest(
      stintLaps.map((lap) => lap.endTime),
      chosen.endTime,
    );
    const firstLap = chosen.startTime <= stintStart + STINT_ANCHOR_SECONDS;
    const lastLap = chosen.endTime >= stintEnd - STINT_ANCHOR_SECONDS;

    // -- rule 1: shortest valid lap of the stint becomes the base map (57-75).
    const validLaps = stintLaps.filter((lap) => lap.isValid && !lap.isOutLap);
    let best =
      minBy(validLaps, byDuration) ?? maxBy(stintLaps, byDuration) ?? chosen;
    // `best` can never be null (both streams end in `orElse(chosen)`), so Java's `best == null`
    // guard is unreachable there too; only the duration floor can still rewrite it.
    if (best.duration < MIN_BASE_LAP_DURATION) {
      best = chosen;
    }

    const baseFrame = await this.fusionEngine.fuse(
      database,
      new FusionOptions(TARGET_FREQUENCY, best.startTime, best.endTime),
    );
    const racingStart = firstLap ? stintStart : chosen.startTime;
    const racingEnd = lastLap ? stintEnd : chosen.endTime;
    const racingFrame = await this.fusionEngine.fuse(
      database,
      new FusionOptions(TARGET_FREQUENCY, racingStart, racingEnd),
    );

    const base = extract(baseFrame);
    const racing = extract(racingFrame);
    if (base === null || racing === null) {
      return this.empty(header, chosen, best);
    }

    const centerLat = mean(base.lat);
    const centerLon = mean(base.lon);
    const lonScale = Math.cos(toRadians(centerLat));
    const baseX = projectX(base.lon, centerLon, lonScale);
    const baseY = projectY(base.lat, centerLat);
    const racingX = projectX(racing.lon, centerLon, lonScale);
    const racingY = projectY(racing.lat, centerLat);

    // -- rule 3: elevation base plane + nearest-point Z snapping on the uniform grid (98-103).
    const zBase = min(base.z);
    const index = new NearestIndex(baseX, baseY);
    const snappedZ = new Float64Array(racingX.length);
    for (let i = 0; i < racingX.length; i++) {
      snappedZ[i] = base.z[index.nearest(racingX[i], racingY[i])];
    }

    // -- rule 4: the 4000-step downsample happens inside the formatting (105-106).
    const baseMap = formatPoints(baseX, baseY, base, zBase, base.z);
    const racingLine = formatPoints(racingX, racingY, racing, zBase, snappedZ);
    const sectors = buildSectors(base, baseX, baseY, zBase, best);

    const center: Track3DCenter = { lat: centerLat, lon: centerLon, lonScale };
    return {
      baseMap,
      racingLine,
      trackName: javaString(header.metadata.trackName),
      trackLayout: javaString(header.metadata.trackLayout),
      layoutKey: javaString(header.metadata.layoutKey),
      fastestLap: best.lap,
      selectedLapInfo: chosen,
      trackSectors: sectors,
      center,
      zBase,
    };
  }

  /**
   * Track3DService.java:124-129 - the "no usable GPS at all" response: empty geometry, identity
   * projection centre and a zero elevation plane. Java's unused `Extracted base` parameter is
   * dropped; `best == null` there is likewise unreachable, so `best.lap` is what ships.
   */
  private empty(header: LapsResponse, selected: LapInfo, best: LapInfo): Track3DResponse {
    const center: Track3DCenter = { lat: 0.0, lon: 0.0, lonScale: 1.0 };
    return {
      baseMap: [],
      racingLine: [],
      trackName: javaString(header.metadata.trackName),
      trackLayout: javaString(header.metadata.trackLayout),
      layoutKey: javaString(header.metadata.layoutKey),
      fastestLap: best.lap,
      selectedLapInfo: selected,
      trackSectors: [],
      center,
      zBase: 0.0,
    };
  }
}

/**
 * Track3DService.java:131-179. A frame with no usable GPS pair (or no `Lap Dist` channel)
 * yields `null`, which is what makes the whole response fall back to {@link Track3DService.empty}.
 * Only frames whose latitude AND longitude are neither NaN nor 0.0 survive, and every other
 * channel is read at that same frame index with a per-channel fallback.
 */
function extract(frame: FusedFrame): Extracted | null {
  const lat = scalarChannel(frame, 'GPS Latitude');
  const lon = scalarChannel(frame, 'GPS Longitude');
  const distance = scalarChannel(frame, 'Lap Dist');
  if (lat === null || lon === null || distance === null) {
    return null;
  }
  let speed = scalarChannel(frame, 'Ground Speed');
  if (speed === null) {
    speed = scalarChannel(frame, 'GPS Speed');
  }
  const throttle = scalarChannel(frame, 'Throttle Pos');
  const brake = scalarChannel(frame, 'Brake Pos');
  const lateral = scalarChannel(frame, 'Path Lateral');
  const width = scalarChannel(frame, 'Track Edge');
  const inPits = scalarChannel(frame, 'In Pits');
  const z = scalarChannel(frame, 'WorldPosZ');
  const time = scalarChannel(frame, 'Time');

  let count = 0;
  for (let i = 0; i < lat.length; i++) {
    if (validCoordinate(lat[i]) && validCoordinate(lon[i])) {
      count++;
    }
  }
  if (count === 0) {
    return null;
  }

  const result: Extracted = {
    lat: new Float64Array(count),
    lon: new Float64Array(count),
    d: new Float64Array(count),
    speed: new Float64Array(count),
    throttle: new Float64Array(count),
    brake: new Float64Array(count),
    lateral: new Float64Array(count),
    width: new Float64Array(count),
    inPits: new Float64Array(count),
    z: new Float64Array(count),
    time: new Float64Array(count),
  };
  let target = 0;
  for (let i = 0; i < lat.length; i++) {
    if (!validCoordinate(lat[i]) || !validCoordinate(lon[i])) {
      continue;
    }
    result.lat[target] = lat[i];
    result.lon[target] = lon[i];
    result.d[target] = valueAt(distance, i, 0.0);
    result.speed[target] = valueAt(speed, i, 0.0);
    result.throttle[target] = valueAt(throttle, i, 0.0);
    result.brake[target] = valueAt(brake, i, 0.0);
    result.lateral[target] = valueAt(lateral, i, 0.0);
    result.width[target] = valueAt(width, i, DEFAULT_TRACK_WIDTH);
    // Java narrows to `int` already here, so a fractional flag reading is truncated toward zero
    // before it is ever stored; formatPoints then casts again, which is a no-op on the result.
    result.inPits[target] = toJavaInt(valueAt(inPits, i, 0.0));
    result.z[target] = valueAt(z, i, 0.0);
    result.time[target] = valueAt(time, i, 0.0);
    target++;
  }
  return result;
}

/**
 * Track3DService.java:181-205. The step is integer division (see header note 4); the emitted
 * `lat` field is the *lateral offset*, and `in_pits` is the Java `(int)` narrowing of a double.
 */
function formatPoints(
  x: Float64Array,
  y: Float64Array,
  data: Extracted,
  zBase: number,
  zValues: Float64Array,
): Track3DPoint[] {
  if (x.length === 0) {
    return [];
  }
  // Java: `Math.max(1, x.length / TARGET_POINTS)` on two ints.
  const step = Math.max(1, Math.trunc(x.length / TARGET_POINTS));
  const points: Track3DPoint[] = [];
  for (let i = 0; i < x.length; i += step) {
    points.push({
      x: safe(x[i]),
      y: safe(y[i]),
      z: safe(zValues[i] - zBase),
      d: safe(data.d[i]),
      speed: safe(data.speed[i]),
      throttle: safe(data.throttle[i]),
      brake: safe(data.brake[i]),
      lat: safe(data.lateral[i]),
      width: safe(data.width[i]),
      in_pits: toJavaInt(safe(data.inPits[i])),
      raw_lat: safe(data.lat[i]),
      raw_lon: safe(data.lon[i]),
    });
  }
  return points;
}

/**
 * Track3DService.java:207-224 - three sector markers on the BASE map, placed by the base lap's
 * sector splits. Any missing split means no sector lines at all.
 */
function buildSectors(
  base: Extracted,
  x: Float64Array,
  y: Float64Array,
  zBase: number,
  baseLap: LapInfo,
): Track3DSectorPoint[] {
  if (baseLap.s1 === null || baseLap.s2 === null || base.time.length === 0) {
    return [];
  }
  const t1 = baseLap.startTime + baseLap.s1;
  const t2 = t1 + baseLap.s2;
  const idx1 = nearestTime(base.time, t1);
  const idx2 = nearestTime(base.time, t2);
  const result: Track3DSectorPoint[] = [];
  result.push(sector(0, 0, base, x, y, zBase));
  result.push(sector(idx1, 1, base, x, y, zBase));
  result.push(sector(idx2, 2, base, x, y, zBase));
  return result;
}

/** Java Math.floorMod for a positive modulus (JS `%` keeps the dividend's sign). */
function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Track3DService.java:226-251 - one marker plus its tangent. The tangent is sampled 5 frames
 * either side (wrapping through `floorMod`, so sector 0's direction spans the loop closure),
 * and an exactly-zero magnitude is replaced by 1.0 so the division cannot produce NaN: the
 * point then reports `dx = dy = 0` rather than a unit vector.
 */
function sector(
  markerIndex: number,
  id: number,
  base: Extracted,
  x: Float64Array,
  y: Float64Array,
  zBase: number,
): Track3DSectorPoint {
  const n = x.length;
  const i1 = floorMod(markerIndex - SECTOR_WINDOW, n);
  const i2 = floorMod(markerIndex + SECTOR_WINDOW, n);
  const dx = x[i2] - x[i1];
  const dy = y[i2] - y[i1];
  let magnitude = Math.hypot(dx, dy);
  if (magnitude === 0.0) {
    magnitude = 1.0;
  }
  return {
    id,
    x: safe(x[markerIndex]),
    y: safe(y[markerIndex]),
    dx: safe(dx / magnitude),
    dy: safe(dy / magnitude),
    z: safe(base.z[markerIndex] - zBase),
    dist: safe(base.d[markerIndex]),
    lat: safe(base.lat[markerIndex]),
    lon: safe(base.lon[markerIndex]),
    lateral: safe(base.lateral[markerIndex]),
    width: safe(base.width[markerIndex]),
  };
}

/** Track3DService.java:253-264 - linear scan for the frame whose time is closest; first wins ties. */
function nearestTime(times: Float64Array, target: number): number {
  let best = 0;
  let bestDiff = Number.MAX_VALUE;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(times[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/** Track3DService.java:266-272 - longitude in metres, compressed by cos(centre latitude). */
function projectX(lon: Float64Array, centerLon: number, lonScale: number): Float64Array {
  const values = new Float64Array(lon.length);
  for (let i = 0; i < lon.length; i++) {
    values[i] = (lon[i] - centerLon) * lonScale * DEG_TO_M;
  }
  return values;
}

/** Track3DService.java:274-280. */
function projectY(lat: Float64Array, centerLat: number): Float64Array {
  const values = new Float64Array(lat.length);
  for (let i = 0; i < lat.length; i++) {
    values[i] = (lat[i] - centerLat) * DEG_TO_M;
  }
  return values;
}

/** Track3DService.java:294-302 - NaN-skipping minimum; +Infinity (empty/all-NaN) reads as 0.0. */
function min(values: Float64Array): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!Number.isNaN(value)) {
      minimum = Math.min(minimum, value);
    }
  }
  return !Number.isFinite(minimum) ? 0.0 : minimum;
}

/** Track3DService.java:304-306 - a GPS 0.0 reading is the game's "no fix" value. */
function validCoordinate(value: number): boolean {
  return !Number.isNaN(value) && value !== 0.0;
}

/**
 * Track3DService.java:308-313. `values` is the channel (null when absent); the length check runs
 * first so a JS out-of-range read (`undefined`, which `Number.isNaN` would call "not NaN") can
 * never leak into the arithmetic.
 */
function valueAt(values: Float64Array | null, index: number, fallback: number): number {
  if (values === null || index >= values.length || Number.isNaN(values[index])) {
    return fallback;
  }
  return values[index];
}

/** Track3DService.java:315-317 - the JSON sanitizer: NaN and both infinities become 0.0. */
function safe(value: number): number {
  return Number.isNaN(value) || !Number.isFinite(value) ? 0.0 : value;
}

/**
 * Java's `(int) double` narrowing: NaN becomes 0, both infinities saturate to the int bounds and
 * everything else truncates toward zero and wraps modulo 2^32 - which is exactly what JS's ToInt32
 * (`| 0`) does. The infinity branches have to be written out because `| 0` maps them to 0. Both
 * call sites run it on a sanitized value, so in practice only the truncation branch is reachable
 * (and `in_pits` is a 0/1 flag channel anyway).
 */
function toJavaInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return 2147483647;
  if (value === Number.NEGATIVE_INFINITY) return -2147483648;
  return Math.trunc(value) | 0;
}

/** Java's `Math.toRadians`: `angdeg / 180.0 * PI`, kept in that evaluation order. */
function toRadians(degrees: number): number {
  return (degrees / 180.0) * Math.PI;
}

/**
 * Track3DService.java:347-412 - the uniform-grid nearest-neighbour index the Z snapping uses.
 * The Java comment says it replaced Python's O(N*M) scan with the same geometry; the bucket
 * layout, the ring order and the fallback scan are all part of the behaviour and are copied.
 */
class NearestIndex {
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  /**
   * `Map<Long, List<Integer>>` keyed by `(cellX << 32) ^ (cellY & 0xffffffffL)`. With cell
   * indices inside int range that fold is a bijection, so a `cx|cy` string key buckets exactly
   * the same points and cannot collide.
   */
  private readonly grid = new Map<string, number[]>();

  constructor(x: Float64Array, y: Float64Array) {
    this.x = x;
    this.y = y;
    for (let i = 0; i < x.length; i++) {
      const key = gridKey(x[i], y[i]);
      const bucket = this.grid.get(key);
      if (bucket === undefined) {
        this.grid.set(key, [i]);
      } else {
        bucket.push(i);
      }
    }
  }

  /**
   * Track3DService.java:366-405. Ring 0 is the single home bucket, then rings 1..6 in
   * `-radius..radius` x `-radius..radius` order with the interior skipped. `best` restarts per
   * ring, so the first ring that yields anything wins - even if a further ring holds a closer
   * point. Distances are the raw squared sum, in Java's multiplication order.
   */
  nearest(pointX: number, pointY: number): number {
    // Java casts these to `int`; the metre-scale values here are far inside int range and
    // `Math.floor` of a finite double is already integral, so the cast is a no-op.
    const cellX = Math.floor(pointX / CELL);
    const cellY = Math.floor(pointY / CELL);
    for (let radius = 0; radius <= MAX_SEARCH_RADIUS; radius++) {
      let best = -1;
      let bestDistance = Number.MAX_VALUE;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) {
            continue;
          }
          // Java hands the cell INDEX back to `key()`, which divides by CELL again; collapsed
          // buckets are what the shipped backend searches, so this stays untouched.
          const candidates = this.grid.get(gridKey(cellX + dx, cellY + dy));
          if (candidates === undefined) {
            continue;
          }
          for (const candidate of candidates) {
            const distance =
              (this.x[candidate] - pointX) * (this.x[candidate] - pointX) +
              (this.y[candidate] - pointY) * (this.y[candidate] - pointY);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = candidate;
            }
          }
        }
      }
      if (best >= 0) {
        return best;
      }
    }

    // Fallback: full linear scan over every base point, first minimum wins.
    let best = 0;
    let bestDistance = Number.MAX_VALUE;
    for (let i = 0; i < this.x.length; i++) {
      const distance =
        (this.x[i] - pointX) * (this.x[i] - pointX) + (this.y[i] - pointY) * (this.y[i] - pointY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }
}

/**
 * Track3DService.java:407-411 - `(long) Math.floor(value / CELL)` per axis. Java's `(long)` cast
 * of NaN is 0, which a `"NaN"` string key would not reproduce; no other case is reachable here
 * because `extract` removed non-finite coordinates and the projection stays finite.
 */
function gridKey(valueX: number, valueY: number): string {
  return `${floorToLong(valueX / CELL)}|${floorToLong(valueY / CELL)}`;
}

function floorToLong(value: number): number {
  return Number.isNaN(value) ? 0 : Math.floor(value);
}

/** Java's `Double.compare`: NaN last, -0.0 before 0.0. */
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

/** `Comparator.comparingDouble(LapInfo::duration)` (Track3DService.java:69-71). */
function byDuration(left: LapInfo, right: LapInfo): number {
  return doubleCompare(left.duration, right.duration);
}

/**
 * `Stream.min(comparingDouble(...))`: `BinaryOperator.minBy` keeps the accumulator on a tie, so
 * the FIRST minimum wins - reproduced by the strict `<`.
 */
function minBy<T>(values: readonly T[], compare: (left: T, right: T) => number): T | null {
  let best: T | null = null;
  for (const value of values) {
    if (best === null || compare(value, best) < 0) {
      best = value;
    }
  }
  return best;
}

/** `Stream.max(comparingDouble(...))`: likewise the FIRST maximum wins. */
function maxBy<T>(values: readonly T[], compare: (left: T, right: T) => number): T | null {
  let best: T | null = null;
  for (const value of values) {
    if (best === null || compare(value, best) > 0) {
      best = value;
    }
  }
  return best;
}

/** `DoubleStream.mapToDouble(...).min().orElse(fallback)` (Track3DService.java:60). */
function lowest(values: readonly number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) {
    result = Math.min(result, value);
  }
  return result;
}

/** `DoubleStream.mapToDouble(...).max().orElse(fallback)` (Track3DService.java:61). */
function highest(values: readonly number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    result = Math.max(result, value);
  }
  return result;
}

/**
 * `SessionMetadata`'s three text fields are `String` (nullable in Java, and `string | null` in
 * the domain type) while `Track3DResponse` declares them as plain `String`. Jackson emits the
 * value it is given - and `LapService`'s metadata reader never leaves a null here - so the cast
 * keeps the JSON byte-identical without pretending the union away.
 */
function javaString(value: string | null): string {
  return value as string;
}
