/**
 * Port of backend-java/src/main/java/com/lmutl/application/TelemetryService.java (135 lines).
 *
 * The use case behind `GET /api/v1/sessions/{id}/telemetry`: resolve the session file, turn
 * `stint_id` / `lap_id` into a trim window, fuse the whole session onto one grid and compute
 * the suspension baselines the frontend subtracts from `Susp Pos` before charting it.
 *
 * Rules copied from the Java source, not re-derived:
 * - `lap_id` is checked FIRST and therefore wins over `stint_id` (TelemetryService.java:34);
 *   an unknown lap is a 404 `Lap {n} not found` - Python by contrast ignores an unknown lap id
 *   and returns the untrimmed session (`endpoints.py:926-934`). Java is the porting source.
 * - otherwise `stint_id` collects every lap of that stint and takes
 *   `min(startTime) .. max(endTime)` (TelemetryService.java:44-53); no such stint is a 404
 *   `Stint {n} not found`.
 * - neither parameter -> `null`/`null` trim, i.e. the full session.
 * - the header comes from `lapService.header(database)` WITHOUT a cache identity, exactly like
 *   Java (TelemetryService.java:33): the key is the resolved path alone, so a `/laps` request
 *   and a `/telemetry` request for the same file share one entry only when the route layer
 *   passes no identity either.
 * - trim bounds are *raw* lap times: the clamping into the session (and the "inverted window
 *   means the whole session" fallback) lives in `FusionEngine.fuse`, mirroring FusionEngine.java
 *   - this service must not pre-clamp.
 * - `freq` validation sits in TelemetryController.java:34-36 in Java. Since the Node route is a
 *   later phase, {@link assertFrequency} is exported here and also called by `load`, so any
 *   caller gets the same 400 `freq must be between 1 and 1000` (the default of 60 stays a route
 *   concern - it is a query-parameter default, not a service one).
 *
 * `suspensionBaselines` is a literal port of the private Java helper, including its oddities:
 * the `maxSpeed < 80` unit guess that picks the 15 m/s vs 50 km/h ceiling, the "straight and
 * slow" mask (|lat| < 0.3, |lon| < 0.5, NaN counting as 999), the `count >= 10` mean-vs-median
 * switch and the median branch's own `Arrays.sort` over only the non-NaN samples. Java's `int`
 * division when sizing the median array (`frames` from `data.length / width`) is kept via
 * `Math.trunc`, and NaN can never reach the sort because the collector filters it.
 */
import type { FusedFrame } from '../domain/types.js';
import { channelOf, scalarChannel } from '../domain/types.js';
import { ApiException } from '../api/error.js';
import type { FusionEngine } from '../infra/fusion/fusion-engine.js';
import { FusionOptions } from '../infra/fusion/fusion-options.js';
import type { LapService } from './lap-service.js';
import type { SessionService } from './session-service.js';

/** TelemetryService.java:133 - `record Result(FusedFrame frame, double[] suspensionBaselines)`. */
export interface TelemetryResult {
  readonly frame: FusedFrame;
  readonly suspensionBaselines: number[];
}

/** TelemetryController.java:34-36 - the route's `freq` guard, exported for reuse. */
export function assertFrequency(frequency: number): void {
  if (!Number.isInteger(frequency) || frequency < 1 || frequency > 1000) {
    throw new ApiException(400, 'freq must be between 1 and 1000');
  }
}

export class TelemetryService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly lapService: LapService,
    private readonly fusionEngine: FusionEngine,
  ) {}

  /**
   * TelemetryService.java:27-61. `stintId` / `lapId` are `null`/`undefined` for "not supplied";
   * the Java `Integer` parameters have no other absent-but-falsy meaning (0 is a real stint).
   */
  async load(
    profileId: string | null | undefined,
    sessionId: string | null,
    frequency: number,
    stintId?: number | null,
    lapId?: number | null,
  ): Promise<TelemetryResult> {
    assertFrequency(frequency);
    const database = await this.sessionService.resolve(profileId, sessionId);

    let trimStart: number | null = null;
    let trimEnd: number | null = null;

    if (supplied(stintId) || supplied(lapId)) {
      const header = await this.lapService.header(database);
      if (supplied(lapId)) {
        const target = findFirst(header.laps, (lap) => lap.lap === lapId);
        if (target === null) {
          throw new ApiException(404, `Lap ${lapId} not found`);
        }
        trimStart = target.startTime;
        trimEnd = target.endTime;
      } else {
        const stintLaps = header.laps.filter((lap) => lap.stint === stintId);
        if (stintLaps.length === 0) {
          throw new ApiException(404, `Stint ${stintId} not found`);
        }
        trimStart = lowest(stintLaps.map((lap) => lap.startTime));
        trimEnd = highest(stintLaps.map((lap) => lap.endTime));
      }
    }

    const frame = await this.fusionEngine.fuse(database, new FusionOptions(frequency, trimStart, trimEnd));
    return { frame, suspensionBaselines: suspensionBaselines(frame) };
  }
}

/**
 * TelemetryService.java:63-131. Returns `[0.0, 0.0, 0.0, 0.0]` whenever the session has no
 * 4-wide `Susp Pos` channel, which is also what the frontend's "no suspension data" case looks
 * like. The sign is *not* corrected here - the fusion engine already flipped `Susp Pos` once,
 * and Java (endpoints.py:1007) documents the same convention for the baselines.
 */
export function suspensionBaselines(frame: FusedFrame): number[] {
  const baselines = [0.0, 0.0, 0.0, 0.0];
  const suspension = channelOf(frame, 'Susp Pos');
  if (suspension === undefined || suspension.width !== 4) {
    return baselines;
  }
  // Java's `frames` is `data.length / width`; both operands are integral, so truncation is a
  // no-op there and `Math.trunc` keeps that here.
  const frames = Math.trunc(suspension.frames());

  let speed = scalarChannel(frame, 'Ground Speed');
  if (speed === null) {
    speed = scalarChannel(frame, 'GPS Speed');
  }
  const gLat = scalarChannel(frame, 'G Force Lat');
  const gLong = scalarChannel(frame, 'G Force Long');

  let maxSpeed = 0.0;
  if (speed !== null) {
    for (const value of speed) {
      if (!Number.isNaN(value)) {
        maxSpeed = Math.max(maxSpeed, value);
      }
    }
  }
  const speedLimit = speed !== null && maxSpeed < 80.0 ? 15.0 : 50.0;

  const sums = [0.0, 0.0, 0.0, 0.0];
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < frames; i++) {
    const lat = gLat === null ? 0.0 : gLat[i];
    const lon = gLong === null ? 0.0 : gLong[i];
    const sp = speed === null ? 0.0 : speed[i];
    const latOk = Math.abs(Number.isNaN(lat) ? 999.0 : lat) < 0.3;
    const lonOk = Math.abs(Number.isNaN(lon) ? 999.0 : lon) < 0.5;
    const speedOk = speed === null || (Number.isNaN(sp) ? 999.0 : sp) < speedLimit;
    if (!(latOk && lonOk && speedOk)) {
      continue;
    }
    for (let wheel = 0; wheel < 4; wheel++) {
      const value = suspension.valueAt(i, wheel);
      if (!Number.isNaN(value)) {
        sums[wheel] += value;
        counts[wheel] += 1;
      }
    }
  }

  for (let wheel = 0; wheel < 4; wheel++) {
    if (counts[wheel] >= 10) {
      baselines[wheel] = sums[wheel] / counts[wheel];
      continue;
    }
    // Java allocated `new double[frames]` and copied the non-NaN prefix out of it; a plain
    // array of the survivors gives the identical median without the oversized allocation.
    const values: number[] = [];
    for (let i = 0; i < frames; i++) {
      const value = suspension.valueAt(i, wheel);
      if (!Number.isNaN(value)) {
        values.push(value);
      }
    }
    if (values.length > 0) {
      values.sort((left, right) => left - right);
      const middle = Math.trunc(values.length / 2);
      baselines[wheel] =
        values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2.0 : values[middle];
    }
  }
  return baselines;
}

/** Java's `stintId != null` on a boxed `Integer`: here the parameter may also be `undefined`. */
function supplied(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

/** `Stream.findFirst().orElseThrow()` - the first match, or null. */
function findFirst<T>(values: readonly T[], predicate: (value: T) => boolean): T | null {
  for (const value of values) {
    if (predicate(value)) {
      return value;
    }
  }
  return null;
}

function lowest(values: readonly number[]): number {
  return values.reduce((acc, value) => Math.min(acc, value), Number.POSITIVE_INFINITY);
}

function highest(values: readonly number[]): number {
  return values.reduce((acc, value) => Math.max(acc, value), Number.NEGATIVE_INFINITY);
}
