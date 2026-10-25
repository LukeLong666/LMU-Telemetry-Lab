/**
 * Ports FusionEngine.java — the numeric core of the backend: it resamples every DuckDB
 * telemetry table of a session onto one evenly spaced master timeline, so the frontend
 * can overlay signals that the game recorded at different rates (position at 60 Hz, gear
 * as change-only events, brake/throttle on their own timestamps).
 *
 * The step order below is load-bearing and must not be re-arranged:
 *   master timeline -> lap channel -> distance (speed integration + per-lap
 *   normalisation) -> gear as-of alignment -> every other table -> steering angle
 *   calibration -> elevation fusion (needs the *normalised* Lap Dist) -> virtual channels
 *   (some of which need the forward-filled sparse channels, hence they run last).
 *
 * Fusion is a pure-CPU hot path and runs synchronously on the caller's task, like Java;
 * worker_threads are deliberately not used here (plan §5 keeps that decision in
 * TelemetryService).
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Logger } from '../../lib/log.js';
import { Channel, officialLength, type FusedFrame, type TrackDefinition } from '../../domain/types.js';
import { CarCatalog } from '../car/car-catalog.js';
import { DuckDbConnectionFactory } from '../duckdb/connection.js';
import * as DuckDbReads from '../duckdb/reads.js';
import { resolve as resolveLapBoundaries, type LapBoundaries } from '../duckdb/lap-boundaries.js';
import { MetadataReader } from '../duckdb/metadata.js';
import { TrackRegistry } from '../track/track-registry.js';
import type { FusionOptions } from './fusion-options.js';
import {
  interp,
  lowerBound,
  mapIndicesToTimes,
  masterTimeline,
  median,
  round3,
  upperBound,
} from './fusion-math.js';
import { computeZ } from './elevation-fusion.js';

/** Tables the engine either derives itself (`Lap`, `Lap Dist`, `Gear`) or never charts. */
const SKIP_TABLES: ReadonlySet<string> = new Set([
  'GPS Time',
  'metadata',
  'channelsList',
  'eventsList',
  'Session Info',
  'Lap',
  'Lap Time',
  'GPS Speed',
  'Gear',
  'Lap Dist',
  'AntiStall Activated',
  'Best LapTime',
  'Best Sector1',
  'Best Sector2',
  'CloudDarkness',
  'Engine Max RPM',
  'Headlights State',
  'Brakes Air Temp',
  'Clutch RPM',
  'FFB Output',
  'Steering Pos Unfiltered',
  'Steering Shaft Torque',
  'SurfaceTypes',
  'Throttle Pos Unfiltered',
  'Time Behind Next',
  'Wind Heading',
  'Wind Speed',
  'Brake Pos Unfiltered',
  'Clutch Pos Unfiltered',
  'RearFlapLegalStatus',
]);

/** Change-only tables: a value holds until the next event, so gaps must be forward-filled. */
const SPARSE_CHANNELS: ReadonlySet<string> = new Set([
  'TyresCompound',
  'WheelsDetached',
  'TC',
  'ABS',
  'TCCut',
  'TCLevel',
  'ABSLevel',
  'TCSlipAngle',
  'Wheel ABS',
  'Wheel TC',
  'WheelABS',
  'WheelTC',
]);

/** Tables whose 1/0 events are on/off pulses rather than level changes. */
const PULSE_CHANNELS: ReadonlySet<string> = new Set(['TC', 'ABS', 'TCCut']);

/** Java's deliberately-empty exclusion list for forward filling; unused there and here. */
const NO_FFILL_CHANNELS: ReadonlySet<string> = new Set<string>([]);

const WHEELS = 4;

/** Java `FusionEngine.DistanceResult`. */
interface DistanceResult {
  readonly speed: Float64Array;
  readonly lapDistance: Float64Array;
}

export class FusionEngine {
  private readonly logger?: Logger;

  constructor(
    private readonly connections: DuckDbConnectionFactory,
    private readonly metadataReader: MetadataReader,
    private readonly trackRegistry: TrackRegistry,
    private readonly carCatalog: CarCatalog,
    logger?: Logger,
  ) {
    this.logger = logger;
  }

  /**
   * Java `fuse(Path, FusionOptions)`. Asynchronous because every DuckDB read is, but the
   * fusion itself is one synchronous pass once the rows are in memory.
   */
  async fuse(database: string, options: FusionOptions): Promise<FusedFrame> {
    try {
      return await this.connections.withConnection(database, (session) =>
        this.fuseOnConnection(session.connection, options),
      );
    } catch (error) {
      this.logger?.error({ err: error }, `Telemetry fusion failed for ${database}`);
      const message = error instanceof Error ? error.message : String(error);
      // Java wrapped everything in IllegalStateException, which the global handler turns
      // into a 500 "Internal Server Error"; a plain Error keeps that mapping identical.
      throw new Error(`Telemetry fusion failed: ${message}`, { cause: error });
    }
  }

  private async fuseOnConnection(
    connection: DuckDBConnection,
    options: FusionOptions,
  ): Promise<FusedFrame> {
    const gps = await DuckDbReads.readValues(connection, 'GPS Time');
    if (gps.length === 0) {
      throw new Error('GPS Time table is empty.');
    }
    const meta = await this.metadataReader.read(connection);
    const trackName = meta.get('TrackName') ?? null;
    const trackLayout = meta.get('TrackLayout') ?? null;
    const rawCar = meta.get('CarName') ?? null;
    const rawClass = meta.get('CarClass') ?? null;

    const sessionStart = gps[0];
    const sessionEnd = gps[gps.length - 1];
    let start = options.trimStart === null ? sessionStart : Math.max(sessionStart, options.trimStart);
    let end = options.trimEnd === null ? sessionEnd : Math.min(sessionEnd, options.trimEnd);
    if (!(end > start)) {
      end = sessionEnd;
      start = sessionStart;
    }

    const frequency = Math.max(1, options.targetFreq);
    const master = masterTimeline(start, end, frequency);
    const channels = new Map<string, Channel>();
    this.put(channels, 'Time', master);

    const boundaries = await resolveLapBoundaries(connection);
    this.put(channels, 'Lap', buildLapChannel(master, boundaries));

    const distance = await this.buildDistance(
      connection,
      gps,
      master,
      boundaries,
      trackName,
      trackLayout,
      frequency,
    );
    this.put(channels, 'Lap Dist', distance.lapDistance);

    this.put(channels, 'Gear', await this.buildGear(connection, master));

    await this.fuseTables(
      connection,
      gps,
      master,
      start,
      end,
      options.trimStart !== null,
      channels,
    );

    await this.buildSteeringAngle(channels, rawCar, rawClass);
    this.buildElevation(channels, trackName, trackLayout);
    this.buildVirtualChannels(channels, distance.speed);

    return { frequency, time: master, channels };
  }

  /**
   * Speed is resampled onto the master grid and integrated into distance, because Lap Dist
   * in the game data is only written when it changes. Each lap segment restarts at 0 (the
   * first one at the offset the session recorded) and is then scaled onto the reference lap
   * length, so laps of slightly different measured length still overlay at the same corner.
   */
  private async buildDistance(
    connection: DuckDBConnection,
    gps: Float64Array,
    master: Float64Array,
    boundaries: LapBoundaries,
    trackName: string | null,
    trackLayout: string | null,
    frequency: number,
  ): Promise<DistanceResult> {
    let sourceSpeed: Float64Array;
    try {
      sourceSpeed = await DuckDbReads.readValues(connection, 'Ground Speed');
    } catch {
      sourceSpeed = await DuckDbReads.readValues(connection, 'GPS Speed');
    }
    if (sourceSpeed.length === 0) {
      sourceSpeed = new Float64Array(gps.length);
    }
    let maxSpeed = 0.0;
    for (const value of sourceSpeed) {
      if (!Number.isNaN(value)) {
        maxSpeed = Math.max(maxSpeed, value);
      }
    }
    // Above 150 the signal can only be km/h, and distance integrates in m/s.
    if (maxSpeed > 150.0) {
      for (let i = 0; i < sourceSpeed.length; i++) {
        sourceSpeed[i] /= 3.6;
      }
    }

    const sourceTime = mapIndicesToTimes(gps, sourceSpeed.length);
    const dt = 1.0 / Math.max(1, frequency);
    const speed = new Float64Array(master.length);
    for (let i = 0; i < master.length; i++) {
      speed[i] = interp(sourceTime, sourceSpeed, master[i]);
    }
    const cumulative = new Float64Array(master.length);
    let total = 0.0;
    for (let i = 0; i < master.length; i++) {
      total += speed[i] * dt;
      cumulative[i] = total;
    }

    let initialOffset = 0.0;
    const firstLapDist = await DuckDbReads.scalarDouble(
      connection,
      'SELECT value FROM "Lap Dist" ORDER BY rowid LIMIT 1',
    );
    if (firstLapDist !== null) {
      initialOffset = firstLapDist;
    }

    const lapDistance = new Float64Array(master.length);
    const segmentEnds = new Float64Array(boundaries.boundaries.length);
    const startIndices = new Int32Array(boundaries.boundaries.length);
    const endIndices = new Int32Array(boundaries.boundaries.length);
    for (let i = 0; i < boundaries.boundaries.length; i++) {
      const boundaryStart = boundaries.boundaries[i];
      const boundaryEnd =
        i + 1 < boundaries.boundaries.length
          ? boundaries.boundaries[i + 1]
          : boundaries.sessionEnd + 1.0;
      const idxStart = lowerBound(master, boundaryStart);
      const idxEnd = lowerBound(master, boundaryEnd);
      startIndices[i] = idxStart;
      endIndices[i] = idxEnd;
      if (idxStart >= master.length) {
        segmentEnds[i] = 0.0;
        continue;
      }
      const limit = Math.min(idxEnd, master.length);
      const baseDistance = cumulative[idxStart];
      let last = 0.0;
      for (let j = idxStart; j < limit; j++) {
        let value = Math.max(0.0, cumulative[j] - baseDistance);
        if (i === 0) {
          value += initialOffset;
        }
        lapDistance[j] = value;
        last = value;
      }
      segmentEnds[i] = last;
    }

    const referenceLength = this.referenceLength(segmentEnds, trackName, trackLayout);
    for (let i = 0; i < boundaries.boundaries.length; i++) {
      const segmentEnd = segmentEnds[i];
      if (segmentEnd < 100.0) {
        continue;
      }
      const ratio = referenceLength > 0 ? segmentEnd / referenceLength : 0.0;
      // Only a near-complete lap is trustworthy enough to scale the whole segment.
      if (ratio > 0.8 && ratio < 1.2) {
        const scale = referenceLength / segmentEnd;
        const limit = Math.min(endIndices[i], master.length);
        for (let j = startIndices[i]; j < limit; j++) {
          lapDistance[j] *= scale;
        }
      }
    }
    return { speed, lapDistance };
  }

  /** Official track length when the registry knows the layout, else the median long lap. */
  private referenceLength(
    segmentEnds: Float64Array,
    trackName: string | null,
    trackLayout: string | null,
  ): number {
    const trackMatch = this.trackRegistry.findTrack(trackName);
    if (trackMatch !== null) {
      const track: TrackDefinition = trackMatch.definition;
      const layoutMatch = this.trackRegistry.findLayout(track, trackLayout, trackMatch.key);
      if (layoutMatch !== null && officialLength(layoutMatch.layout) > 0) {
        return officialLength(layoutMatch.layout);
      }
    }
    const valid: number[] = [];
    for (const end of segmentEnds) {
      if (end > 2000.0) {
        valid.push(end);
      }
    }
    if (valid.length > 0) {
      return median(Float64Array.from(valid));
    }
    return 6019.0;
  }

  /**
   * Gear is a change-only event table: each master frame takes the last event at or before
   * its timestamp (`upperBound - 1`), so an event exactly on a grid point wins over the
   * previous one. `timestamps[0] = -1.0` seeds the pre-session value.
   */
  private async buildGear(
    connection: DuckDBConnection,
    master: Float64Array,
  ): Promise<Float64Array | null> {
    const events = await DuckDbReads.readEventsOrEmpty(connection, 'Gear');
    if (events.length === 0) {
      return null;
    }
    let initialGear: number;
    if (events.length >= 2) {
      const first = events[0].value;
      const second = events[1].value;
      // A session that starts parked logs gear 0 then the first real shift; rewind one step.
      initialGear = first === 0.0 && second > 0.0 ? second - 1.0 : first;
    } else {
      initialGear = events[0].value;
    }
    const timestamps = new Float64Array(events.length + 1);
    const values = new Float64Array(events.length + 1);
    timestamps[0] = -1.0;
    values[0] = initialGear;
    for (let i = 0; i < events.length; i++) {
      timestamps[i + 1] = events[i].ts;
      values[i + 1] = events[i].value;
    }
    const gear = new Float64Array(master.length);
    for (let i = 0; i < master.length; i++) {
      let index = upperBound(timestamps, master[i]) - 1;
      index = Math.max(0, Math.min(values.length - 1, index));
      gear[i] = values[index];
    }
    return gear;
  }

  /**
   * Every remaining table, dispatched on its shape: wheel tables (`value1`..`value4`) and
   * single-value ones, each either event-style (has `ts`, as-of aligned) or frame-style
   * (row index mapped onto the GPS timeline).
   */
  private async fuseTables(
    connection: DuckDBConnection,
    gps: Float64Array,
    master: Float64Array,
    start: number,
    end: number,
    trimActive: boolean,
    channels: Map<string, Channel>,
  ): Promise<void> {
    for (const table of await DuckDbReads.tableNames(connection)) {
      if (SKIP_TABLES.has(table)) {
        continue;
      }
      const columns = await DuckDbReads.columns(connection, table);
      if (columns.length === 0) {
        continue;
      }
      const hasTimestamp = columns.includes('ts');
      const wheelTable =
        columns.includes('value1') &&
        columns.includes('value2') &&
        columns.includes('value3') &&
        columns.includes('value4');
      if (wheelTable) {
        if (hasTimestamp) {
          let events = await DuckDbReads.readEventWheels(connection, table);
          let carryAdded = false;
          if (trimActive && SPARSE_CHANNELS.has(table)) {
            const carry = await DuckDbReads.lastEventWheelBefore(connection, table, start + 1e-6);
            if (carry !== null) {
              const withCarry: DuckDbReads.EventWheel[] = [
                { ts: start, values: carry.values },
                ...events,
              ];
              events = withCarry;
              carryAdded = true;
            }
          }
          if (events.length === 0 || (!carryAdded && !hasEventWheelInRange(events, start, end))) {
            continue;
          }
          // Java's `double[master.length][4]` is carried in the flat [frame*4+wheel] layout
          // that putVector flattens to anyway; the loop nesting below is unchanged.
          const data = new Float64Array(master.length * WHEELS).fill(Number.NaN);
          assignEventWheels(data, master, events, start, end, table, carryAdded);
          this.putVector(channels, table, data);
        } else {
          const source = await DuckDbReads.readWheelValues(connection, table);
          const sourceTime = mapIndicesToTimes(gps, source.length === 0 ? 0 : source[0].length);
          const data = new Float64Array(master.length * WHEELS);
          for (let wheel = 0; wheel < WHEELS; wheel++) {
            for (let i = 0; i < master.length; i++) {
              data[i * WHEELS + wheel] =
                source.length <= wheel || source[wheel].length === 0
                  ? Number.NaN
                  : interp(sourceTime, source[wheel], master[i]);
            }
          }
          this.putVector(channels, table, data);
        }
        continue;
      }

      for (const column of columns) {
        if (column === 'ts') {
          continue;
        }
        const targetName = column === 'value' ? table : `${table}_${column}`;
        if (hasTimestamp) {
          let events =
            column === 'value'
              ? await DuckDbReads.readEvents(connection, table)
              : await DuckDbReads.readEventsColumn(connection, table, column);
          let carryAdded = false;
          if (trimActive && SPARSE_CHANNELS.has(table)) {
            const carry = await DuckDbReads.lastEventBefore(connection, table, start + 1e-6);
            if (carry !== null) {
              const withCarry: DuckDbReads.Event[] = [{ ts: start, value: carry.value }, ...events];
              events = withCarry;
              carryAdded = true;
            }
          }
          if (events.length === 0 || (!carryAdded && !hasEventInRange(events, start, end))) {
            continue;
          }
          const data = new Float64Array(master.length).fill(Number.NaN);
          assignEvents(data, master, events, start, end, table, carryAdded);
          this.put(channels, targetName, data);
        } else {
          const source = await DuckDbReads.readColumn(connection, table, column);
          const sourceTime = mapIndicesToTimes(gps, source.length);
          const data = new Float64Array(master.length);
          for (let i = 0; i < master.length; i++) {
            data[i] =
              source.length === 0 ? Number.NaN : interp(sourceTime, source, master[i]);
          }
          this.put(channels, targetName, data);
        }
      }
    }
  }

  /** Steering Pos is a -1..1 normalised signal; convert it to degrees with the car's lock. */
  private async buildSteeringAngle(
    channels: Map<string, Channel>,
    rawCar: string | null,
    rawClass: string | null,
  ): Promise<void> {
    const steering = channels.get('Steering Pos');
    if (steering === undefined || steering.width !== 1) {
      return;
    }
    const values = steering.data.slice();
    let max = 0.0;
    for (const value of values) {
      if (!Number.isNaN(value)) {
        max = Math.max(max, Math.abs(value));
      }
    }
    const lock = this.carCatalog.getCarInfo(rawCar, rawClass).steeringLock;
    if (max <= 2.0) {
      for (let i = 0; i < values.length; i++) {
        values[i] *= lock / 2.0;
      }
    }
    this.put(channels, 'Steering Angle', values);
  }

  private buildElevation(
    channels: Map<string, Channel>,
    trackName: string | null,
    trackLayout: string | null,
  ): void {
    const lat = channels.get('GPS Latitude');
    const lon = channels.get('GPS Longitude');
    const distance = channels.get('Lap Dist');
    if (
      lat === undefined ||
      lon === undefined ||
      distance === undefined ||
      lat.width !== 1 ||
      lon.width !== 1
    ) {
      return;
    }
    const z = computeZ(lat.data, lon.data, distance.data, trackName, trackLayout, this.trackRegistry);
    this.put(channels, 'WorldPosZ', z);
  }

  /**
   * Channels the game does not record at all, derived from the fused ones.
   */
  private buildVirtualChannels(
    channels: Map<string, Channel>,
    groundSpeed: Float64Array,
  ): void {
    const wheelSpeed = channels.get('Wheel Speed');
    if (wheelSpeed !== undefined && wheelSpeed.width === WHEELS) {
      const source = wheelSpeed.data;
      const slip = new Float64Array(source.length);
      // Java divided two ints here, so the frame count truncates.
      const frames = Math.trunc(source.length / WHEELS);
      for (let frame = 0; frame < frames; frame++) {
        const speed = groundSpeed[Math.min(frame, groundSpeed.length - 1)];
        for (let wheel = 0; wheel < WHEELS; wheel++) {
          const wheelValue = source[frame * WHEELS + wheel];
          let value = (wheelValue - speed) / Math.max(speed, 0.5);
          if (wheel === 0 || wheel === 2) {
            value = -value;
          }
          slip[frame * WHEELS + wheel] = value;
        }
      }
      this.putVector(channels, 'Slip Ratio', slip);
    }

    const left = channels.get('TyresTempLeft');
    const centre = channels.get('TyresTempCentre');
    const right = channels.get('TyresTempRight');
    if (
      left !== undefined &&
      centre !== undefined &&
      right !== undefined &&
      left.width === WHEELS &&
      centre.width === WHEELS &&
      right.width === WHEELS
    ) {
      const inside = new Float64Array(left.data.length);
      const outside = new Float64Array(left.data.length);
      const frames = Math.trunc(left.data.length / WHEELS);
      for (let frame = 0; frame < frames; frame++) {
        for (let wheel = 0; wheel < WHEELS; wheel++) {
          const index = frame * WHEELS + wheel;
          if (wheel === 0 || wheel === 2) {
            inside[index] = right.data[index];
            outside[index] = left.data[index];
          } else {
            inside[index] = left.data[index];
            outside[index] = right.data[index];
          }
        }
      }
      this.putVector(channels, 'TyresTempInside', inside);
      this.putVector(channels, 'TyresTempOutside', outside);
    }

    if (channels.has('Wheel ABS')) {
      this.overrideWheelMax(channels, 'Wheel ABS', 'ABS');
    } else {
      this.overrideWheelMax(channels, 'WheelABS', 'ABS');
    }
    if (channels.has('Wheel TC')) {
      this.overrideWheelMax(channels, 'Wheel TC', 'TC');
    } else {
      this.overrideWheelMax(channels, 'WheelTC', 'TC');
    }

    const suspension = channels.get('Susp Pos');
    if (suspension !== undefined && suspension.width === WHEELS) {
      const flipped = suspension.data.slice();
      for (let i = 0; i < flipped.length; i++) {
        flipped[i] = -flipped[i];
      }
      this.replaceVector(channels, 'Susp Pos', flipped);
    }
  }

  /** Per-wheel signals collapse to the most critical wheel for the scalar channel. */
  private overrideWheelMax(
    channels: Map<string, Channel>,
    sourceName: string,
    targetName: string,
  ): void {
    const source = channels.get(sourceName);
    if (source === undefined || source.width !== WHEELS) {
      return;
    }
    // Channel.frames() divides in floating point; Java's integer division truncated.
    const frames = Math.trunc(source.frames());
    const result = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      let max = Number.NaN;
      for (let wheel = 0; wheel < WHEELS; wheel++) {
        const value = source.valueAt(frame, wheel);
        if (!Number.isNaN(value)) {
          max = Number.isNaN(max) ? value : Math.max(max, value);
        }
      }
      result[frame] = max;
    }
    channels.set(targetName, Channel.scalar(targetName, result));
  }

  private put(channels: Map<string, Channel>, name: string, data: Float64Array | null): void {
    if (data === null || data === undefined) {
      return;
    }
    const unique = uniqueName(channels, name);
    channels.set(unique, Channel.scalar(unique, data));
  }

  private putVector(
    channels: Map<string, Channel>,
    name: string,
    flat: Float64Array | null,
  ): void {
    if (flat === null || flat === undefined) {
      return;
    }
    const unique = uniqueName(channels, name);
    channels.set(unique, Channel.fromFlat(unique, WHEELS, flat));
  }

  private replaceVector(
    channels: Map<string, Channel>,
    name: string,
    flat: Float64Array,
  ): void {
    channels.set(name, Channel.fromFlat(name, WHEELS, flat));
  }
}

/** Java `buildLapChannel`; module-level because it touches no engine state. */
function buildLapChannel(master: Float64Array, boundaries: LapBoundaries): Float64Array {
  const lap = new Float64Array(master.length);
  for (let i = 0; i < boundaries.boundaries.length; i++) {
    const boundaryStart = boundaries.boundaries[i];
    const boundaryEnd =
      i + 1 < boundaries.boundaries.length
        ? boundaries.boundaries[i + 1]
        : boundaries.sessionEnd + 1.0;
    for (let j = 0; j < master.length; j++) {
      if (master[j] >= boundaryStart && master[j] < boundaryEnd) {
        lap[j] = i;
      }
    }
  }
  return lap;
}

function hasEventInRange(events: readonly DuckDbReads.Event[], start: number, end: number): boolean {
  for (const event of events) {
    const ts = round3(event.ts);
    if (ts >= start && ts <= end) {
      return true;
    }
  }
  return false;
}

function hasEventWheelInRange(
  events: readonly DuckDbReads.EventWheel[],
  start: number,
  end: number,
): boolean {
  for (const event of events) {
    const ts = round3(event.ts);
    if (ts >= start && ts <= end) {
      return true;
    }
  }
  return false;
}

/**
 * As-of placement of one event onto the grid: the event lands on the first master frame at
 * or after its rounded timestamp, overwriting whatever an earlier event put there.
 */
function assignEvents(
  target: Float64Array,
  master: Float64Array,
  events: readonly DuckDbReads.Event[],
  start: number,
  end: number,
  table: string,
  carryPrefix: boolean,
): void {
  let cursor = 0;
  for (const event of events) {
    const carry = carryPrefix && cursor === 0;
    cursor++;
    const ts = round3(event.ts);
    // Carry-over is forced to the first master frame. Ordinary events keep
    // Python's raw-start filter (a rounded timestamp can be < raw start).
    if (!carry && (ts < start || ts > end)) {
      continue;
    }
    let index = lowerBound(master, ts);
    index = Math.min(index, master.length - 1);
    if (index < 0) {
      continue;
    }
    if (PULSE_CHANNELS.has(table)) {
      const value = event.value;
      if (value === 1.0) {
        target[index] = 1.0;
      } else if (value === 0.0) {
        // An intervention ends on the *next* frame if this one already holds a new start,
        // otherwise the stop overwrites the value it was standing on.
        if (target[index] === 1.0 && index + 1 < target.length) {
          target[index + 1] = 0.0;
        } else {
          target[index] = 0.0;
        }
      } else {
        target[index] = value;
      }
    } else {
      target[index] = event.value;
    }
  }
  if (SPARSE_CHANNELS.has(table)) {
    forwardFillScalar(target);
    if (table === 'WheelsDetached') {
      replaceNaNs(target, 0.0);
    }
  }
}

function assignEventWheels(
  target: Float64Array,
  master: Float64Array,
  events: readonly DuckDbReads.EventWheel[],
  start: number,
  end: number,
  table: string,
  carryPrefix: boolean,
): void {
  let cursor = 0;
  for (const event of events) {
    const carry = carryPrefix && cursor === 0;
    cursor++;
    const ts = round3(event.ts);
    if (!carry && (ts < start || ts > end)) {
      continue;
    }
    const index = Math.min(lowerBound(master, ts), master.length - 1);
    for (let wheel = 0; wheel < WHEELS; wheel++) {
      target[index * WHEELS + wheel] = event.values[wheel];
    }
  }
  if (SPARSE_CHANNELS.has(table)) {
    forwardFillVector(target);
    if (table === 'WheelsDetached') {
      const frames = Math.trunc(target.length / WHEELS);
      for (let frame = 0; frame < frames; frame++) {
        for (let wheel = 0; wheel < WHEELS; wheel++) {
          const at = frame * WHEELS + wheel;
          if (Number.isNaN(target[at])) {
            target[at] = 0.0;
          }
        }
      }
    }
  }
}

function forwardFillScalar(values: Float64Array): void {
  let last = Number.NaN;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      values[i] = last;
    } else {
      last = values[i];
    }
  }
}

/** Wheel-major fill (Java iterated `for wheel` outside), on the flat [frame*4+wheel] layout. */
function forwardFillVector(values: Float64Array): void {
  for (let wheel = 0; wheel < WHEELS; wheel++) {
    let last = Number.NaN;
    for (let at = wheel; at < values.length; at += WHEELS) {
      if (Number.isNaN(values[at])) {
        values[at] = last;
      } else {
        last = values[at];
      }
    }
  }
}

function replaceNaNs(values: Float64Array, replacement: number): void {
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      values[i] = replacement;
    }
  }
}

/** Two tables can produce the same channel name; the second gets a `_2`, `_3`, ... suffix. */
function uniqueName(channels: Map<string, Channel>, name: string): string {
  if (!channels.has(name)) {
    return name;
  }
  let suffix = 2;
  let candidate = `${name}_${suffix}`;
  while (channels.has(candidate)) {
    suffix++;
    candidate = `${name}_${suffix}`;
  }
  return candidate;
}
