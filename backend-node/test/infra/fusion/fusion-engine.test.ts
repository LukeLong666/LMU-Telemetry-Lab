import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/lib/log.js';
import { CarCatalog } from '../../../src/infra/car/car-catalog.js';
import { DuckDbConnectionFactory } from '../../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../../src/infra/duckdb/metadata.js';
import { TrackRegistry } from '../../../src/infra/track/track-registry.js';
import { computeZ } from '../../../src/infra/fusion/elevation-fusion.js';
import { FusionEngine } from '../../../src/infra/fusion/fusion-engine.js';
import { FusionOptions } from '../../../src/infra/fusion/fusion-options.js';
import {
  interp,
  lowerBound,
  mapIndicesToTimes,
  masterTimeline,
  mean,
  median,
  round3,
  uniqueFirst,
  upperBound,
} from '../../../src/infra/fusion/fusion-math.js';
import { channelOf, hasChannel, type FusedFrame } from '../../../src/domain/types.js';
import {
  createFusionFixture,
  fusionFixtureStatements,
  makeTempDir,
  writeDatabase,
  type DuckDbFixture,
} from '../../helpers/duckdb-fixture.js';
import fs from 'node:fs';
import path from 'node:path';

/** Fusion logs its failure before rethrowing; keep the noise out of the test output. */
function silentLogger(): Logger {
  return {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  } as unknown as Logger;
}

const factory = new DuckDbConnectionFactory();
const registry = new TrackRegistry();
const engine = new FusionEngine(
  factory,
  new MetadataReader(silentLogger()),
  registry,
  new CarCatalog(),
  silentLogger(),
);

function value(frame: FusedFrame, name: string, frameIndex: number): number {
  const channel = channelOf(frame, name);
  if (channel === undefined) throw new Error(`missing channel ${name}`);
  return channel.data[frameIndex];
}

function wheel(
  frame: FusedFrame,
  name: string,
  frameIndex: number,
  wheelIndex: number,
): number {
  const channel = channelOf(frame, name);
  if (channel === undefined) throw new Error(`missing channel ${name}`);
  return channel.valueAt(frameIndex, wheelIndex);
}

describe('FusionMath', () => {
  it('builds the numpy-arange master grid', () => {
    // 10 Hz over 120 s -> ceil(120 / 0.1) + 1 = 1201 frames, endpoints included.
    const master = masterTimeline(0, 120, 10);
    expect(master.length).toBe(1201);
    expect(master[0]).toBe(0);
    expect(master[1]).toBe(0.1);
    expect(master[300]).toBe(30);
    expect(master[1200]).toBe(120);
  });

  it('rounds an exact half-millisecond up like numpy does', () => {
    const master = masterTimeline(0.0005, 0.0005, 10);
    expect(master.length).toBe(1);
    expect(master[0]).toBe(0.001);
  });

  it('never produces an empty grid', () => {
    // Java clamped the count with Math.max(1, count); an inverted range must not be empty.
    const master = masterTimeline(5, 4, 10);
    expect(master.length).toBe(1);
    expect(master[0]).toBe(5);
  });

  it('bounds searches on the left and right edge of a run', () => {
    const grid = new Float64Array([1, 3, 3, 3, 5]);
    expect(lowerBound(grid, 3)).toBe(1);
    expect(upperBound(grid, 3)).toBe(4);
    expect(lowerBound(grid, 4)).toBe(4);
    expect(upperBound(grid, 4)).toBe(4);
    expect(lowerBound(grid, 0)).toBe(0);
    expect(upperBound(grid, 9)).toBe(5);
    expect(lowerBound(new Float64Array(0), 1)).toBe(0);
  });

  it('interpolates with clamped edges and exact hits', () => {
    const xp = new Float64Array([0, 10]);
    const fp = new Float64Array([0, 100]);
    expect(interp(xp, fp, 5)).toBe(50);
    expect(interp(xp, fp, -1)).toBe(0);
    expect(interp(xp, fp, 11)).toBe(100);
    expect(interp(xp, fp, 10)).toBe(100);
    expect(interp(xp, fp, 0)).toBe(0);
    expect(interp(new Float64Array(0), fp, 1)).toBeNaN();
    // A NaN sample in the value array propagates instead of being skipped.
    const withNaN = new Float64Array([1, Number.NaN]);
    expect(interp(xp, withNaN, 10)).toBeNaN();
  });

  it('maps row indices onto the GPS timeline', () => {
    const gps = new Float64Array([0, 1, 2, 3]);
    expect(Array.from(mapIndicesToTimes(gps, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(mapIndicesToTimes(gps, 2))).toEqual([0, 3]);
    expect(Array.from(mapIndicesToTimes(gps, 3))).toEqual([0, 1.5, 3]);
    expect(Array.from(mapIndicesToTimes(gps, 1))).toEqual([0]);
    expect(Array.from(mapIndicesToTimes(gps, 0))).toEqual([]);
    expect(Array.from(mapIndicesToTimes(new Float64Array(0), 5))).toEqual([]);
    // A signal sampled at a third of the GPS rate still spans the whole session.
    const slow = mapIndicesToTimes(gps, 2);
    expect(slow[1]).toBe(3);
  });

  it('de-duplicates with Java sort order, keeping NaN last', () => {
    const unique = uniqueFirst(new Float64Array([3, 1, 1, 2, Number.NaN, Number.NaN]));
    expect(unique.length).toBe(5);
    expect(Array.from(unique.subarray(0, 3))).toEqual([1, 2, 3]);
    // Java compared with `!=`, so two NaN neighbours are *not* duplicates.
    expect(Number.isNaN(unique[3])).toBe(true);
    expect(Number.isNaN(unique[4])).toBe(true);
  });

  it('takes the NaN-free median with integer division', () => {
    expect(median(new Float64Array([1, 2, 3]))).toBe(2);
    expect(median(new Float64Array([1, 2, 3, 4]))).toBe(2.5);
    // The NaN is dropped first, so the even-count branch averages the remaining pair.
    expect(median(new Float64Array([5, Number.NaN, 1]))).toBe(3);
    expect(median(new Float64Array(0))).toBe(0);
    expect(median(new Float64Array([Number.NaN, Number.NaN]))).toBe(0);
  });

  it('averages only usable samples', () => {
    expect(mean(new Float64Array([1, 2, 3]))).toBe(2);
    expect(mean(new Float64Array([Number.NaN, 4]))).toBe(4);
    expect(mean(new Float64Array([Number.NaN]))).toBe(0);
  });

  it('snaps to milliseconds with Java rounding', () => {
    expect(round3(20.044999)).toBe(20.045);
    expect(round3(1.2345)).toBe(1.235);
    // Java rounds half *up*, not half away from zero: -1234.5 -> -1234.
    expect(round3(-1.2345)).toBe(-1.234);
    // Java's Math.round returns 0 for NaN, where JS Math.round returns NaN.
    expect(round3(Number.NaN)).toBe(0);
    // ... and 0, not -0, for a value that rounds onto zero from below.
    expect(Object.is(round3(-0.00004), 0)).toBe(true);
    expect(round3(Number.POSITIVE_INFINITY)).toBe(Number.MAX_SAFE_INTEGER / 1000);
  });
});

describe('ElevationFusion.computeZ', () => {
  // tracks.json -> Silverstone / National Circuit:
  //   dist 0, 380, 900, 1400, 1900, 2639  /  alt 155, 155.8, 152, 150.5, 153.5, 155
  const TRACK = 'Silverstone';
  const LAYOUT = 'National Circuit';

  it('interpolates the reference profile and smooths it', () => {
    // Four samples, so window = 4 and pad = 2.
    const lat = new Float64Array([45.6, 45.6, 45.6, 45.6]);
    const lon = new Float64Array([4.4, 4.4, 4.4, 4.4]);
    const distance = new Float64Array([0, 380, 900, 1400]);
    const z = computeZ(lat, lon, distance, TRACK, LAYOUT, registry);

    // cd = the same four values, telD = cd - 0, maxTelD = 1400, refMax = 2639, so
    // normalized = [0, 380/1400*2639, 900/1400*2639, 2639].
    const refMax = 2639;
    const maxTelD = 1400;
    const n1 = (380 / maxTelD) * refMax;
    const n2 = (900 / maxTelD) * refMax;
    const z0 = 155;
    // n1 sits between (380, 155.8) and (900, 152); n2 between (1400, 150.5) and (1900, 153.5).
    const z1 = 155.8 + ((n1 - 380) / (900 - 380)) * (152 - 155.8);
    const z2 = 150.5 + ((n2 - 1400) / (1900 - 1400)) * (153.5 - 150.5);
    const z3 = 155;
    // normalized[0] = 0 clamps onto the first point and normalized[3] = refMax onto the
    // last, so offset = 155 - 155 = 0 and error = 155 - 155 = 0: zCorrected = zRaw.
    // Each cleaned[i] equals a cd entry, so zFull = [z0, z1, z2, z3] exactly.
    // The 4-wide moving average with edge replication gives:
    expect(z.length).toBe(4);
    expect(z[0]).toBe((z0 + z0 + z0 + z1) / 4);
    expect(z[1]).toBe((z0 + z0 + z1 + z2) / 4);
    expect(z[2]).toBe((z0 + z1 + z2 + z3) / 4);
    expect(z[3]).toBe((z1 + z2 + z3 + z3) / 4);
  });

  it('maps a two-sample run onto the profile endpoints', () => {
    const lat = new Float64Array([45.6, 45.6]);
    const distance = new Float64Array([123, 1603]);
    const z = computeZ(lat, null, distance, TRACK, LAYOUT, registry);
    // telD = [0, 1480] -> normalized = [0, 2639] -> the profile's first and last altitude.
    expect(z[0]).toBe(155);
    expect(z[1]).toBe(155);
  });

  it('returns zeros when there is nothing to fuse', () => {
    const lat = new Float64Array(3).fill(45.6);
    // A single unique distance cannot span the profile.
    expect(Array.from(computeZ(lat, null, new Float64Array([500, 500, 500]), TRACK, LAYOUT, registry))).toEqual([0, 0, 0]);
    // Too short a run (maxTelD = 0.5 <= 1.0) is noise, not elevation.
    expect(Array.from(computeZ(lat, null, new Float64Array([10, 10.5, 10.5]), TRACK, LAYOUT, registry))).toEqual([0, 0, 0]);
    // Every distance NaN -> cleaned = 0 -> a single unique value.
    expect(Array.from(computeZ(lat, null, new Float64Array(3).fill(Number.NaN), TRACK, LAYOUT, registry))).toEqual([0, 0, 0]);
    // Unknown track, empty input, missing distance.
    expect(Array.from(computeZ(lat, null, new Float64Array([0, 1000, 2000]), 'Unknown Circuit', null, registry))).toEqual([0, 0, 0]);
    expect(computeZ(new Float64Array(0), null, new Float64Array([0, 1000]), TRACK, LAYOUT, registry).length).toBe(0);
    expect(Array.from(computeZ(lat, null, null, TRACK, LAYOUT, registry))).toEqual([0, 0, 0]);
  });
});

describe('FusionEngine', () => {
  let fixture: DuckDbFixture;
  let frame: FusedFrame;

  beforeAll(async () => {
    fixture = await createFusionFixture();
    frame = await engine.fuse(fixture.database, FusionOptions.of(10));
  }, 120_000);

  afterAll(() => {
    fixture?.dispose();
  });

  it('lays every channel on the master timeline', () => {
    expect(frame.frequency).toBe(10);
    // 10 Hz across the 120 s session -> 1201 frames, and Time is the grid itself.
    expect(frame.time.length).toBe(1201);
    expect(frame.time[0]).toBe(0);
    expect(frame.time[1200]).toBe(120);
    expect(channelOf(frame, 'Time')?.data).toBe(frame.time);
    expect(Array.from(frame.channels.keys())).toEqual([
      // Derived first, in the order fuse() produces them...
      'Time',
      'Lap',
      'Lap Dist',
      'Gear',
      // ...then the tables in SHOW TABLES order, with per-column suffixes...
      'ABS',
      'Engine Data',
      'Engine Data_Oil Pressure',
      'GPS Latitude',
      'GPS Longitude',
      'Ground Speed',
      'In Pits',
      'RPM',
      'Setup_Throttle',
      'Setup_Brake',
      'Steering Pos',
      'Susp Pos',
      'TCCut',
      'Throttle Pos',
      'Tyre Loads',
      'TyresCompound',
      'TyresTempCentre',
      'TyresTempLeft',
      'TyresTempRight',
      'Wheel ABS',
      'Wheel Speed',
      'WheelTC',
      'WheelsDetached',
      // ...then the virtual channels. ABS stayed in its slot (overwritten in place),
      // TC was appended because no `TC` table exists in this fixture.
      'Steering Angle',
      'WorldPosZ',
      'Slip Ratio',
      'TyresTempInside',
      'TyresTempOutside',
      'TC',
    ]);
  });

  it('skips the tables the engine derives or never charts', () => {
    for (const skipped of [
      'GPS Time',
      'GPS Speed',
      'Lap Time',
      'metadata',
      'Throttle Pos Unfiltered',
      'Setup',
    ]) {
      expect(hasChannel(frame, skipped), skipped).toBe(false);
    }
    // 'Lap' and 'Lap Dist' exist only because the engine built them itself.
    expect(channelOf(frame, 'Lap')?.width).toBe(1);
    expect(channelOf(frame, 'Lap')?.frames()).toBe(1201);
  });

  it('keeps wheel channels four wide and scalar channels one wide', () => {
    for (const name of [
      'Susp Pos',
      'Tyre Loads',
      'Wheel ABS',
      'Wheel Speed',
      'WheelTC',
      'TyresTempLeft',
      'TyresTempCentre',
      'TyresTempRight',
      'Slip Ratio',
      'TyresTempInside',
      'TyresTempOutside',
    ]) {
      const channel = channelOf(frame, name);
      expect(channel?.width, name).toBe(4);
      expect(channel?.data.length, name).toBe(1201 * 4);
      expect(channel?.frames(), name).toBe(1201);
    }
    for (const name of ['Gear', 'Lap Dist', 'ABS', 'TC', 'TCCut', 'WorldPosZ', 'RPM']) {
      expect(channelOf(frame, name)?.width, name).toBe(1);
    }
  });

  it('numbers the laps from the boundary list, not the event values', () => {
    // boundaries = [0, 30, 70]; the third segment runs to sessionEnd + 1.
    expect(value(frame, 'Lap', 0)).toBe(0);
    expect(value(frame, 'Lap', 299)).toBe(0);
    expect(value(frame, 'Lap', 300)).toBe(1);
    expect(value(frame, 'Lap', 699)).toBe(1);
    expect(value(frame, 'Lap', 700)).toBe(2);
    expect(value(frame, 'Lap', 1200)).toBe(2);
  });

  it('aligns gear as-of, so a grid point takes the event on it', () => {
    // Gear events: (5, 0), (12, 4), (35, 5), (78, 2). The first is 0 and the second > 0,
    // so the pre-session value is 4 - 1 = 3, seeded at ts = -1.
    expect(value(frame, 'Gear', 0)).toBe(3);
    expect(value(frame, 'Gear', 49)).toBe(3);
    // An event landing exactly on frame 50 wins over the seed.
    expect(value(frame, 'Gear', 50)).toBe(0);
    expect(value(frame, 'Gear', 119)).toBe(0);
    expect(value(frame, 'Gear', 120)).toBe(4);
    expect(value(frame, 'Gear', 349)).toBe(4);
    expect(value(frame, 'Gear', 350)).toBe(5);
    expect(value(frame, 'Gear', 779)).toBe(5);
    expect(value(frame, 'Gear', 780)).toBe(2);
    expect(value(frame, 'Gear', 1200)).toBe(2);
  });

  it('integrates speed into distance and rescales near-complete laps', () => {
    // Ground Speed is a constant 216 km/h; max > 150 -> 216/3.6 = 60 m/s exactly, i.e.
    // 60 * 0.1 = 6 m of travel per master frame.
    // Lap 0 keeps the offset the session recorded (first row of "Lap Dist" = 100).
    expect(value(frame, 'Lap Dist', 0)).toBe(100);
    expect(value(frame, 'Lap Dist', 1)).toBeCloseTo(106, 6);
    // 1894 m is only 0.718 of the reference length, so lap 0 stays unscaled.
    expect(value(frame, 'Lap Dist', 299)).toBeCloseTo(100 + 6 * 299, 6);
    // Lap 1 restarts at 0 and runs 400 frames -> 2400 m. 2400 / 2639 = 0.909 is inside the
    // 0.8..1.2 window, so the whole segment is scaled onto the official length.
    expect(value(frame, 'Lap Dist', 300)).toBe(0);
    expect(value(frame, 'Lap Dist', 699)).toBeCloseTo(2639, 6);
    // Lap 2 covers 501 frames -> 3000 m -> ratio 1.137, also scaled.
    expect(value(frame, 'Lap Dist', 700)).toBe(0);
    expect(value(frame, 'Lap Dist', 1200)).toBeCloseTo(2639, 6);
  });

  it('does not let the unit conversion leak into the fused channel', () => {
    // buildDistance divides its own copy by 3.6; fuseTables re-reads the table raw.
    expect(value(frame, 'Ground Speed', 0)).toBe(216);
    expect(value(frame, 'Ground Speed', 1200)).toBe(216);
  });

  it('resamples frame tables that were recorded at a different rate', () => {
    // RPM has 61 rows for 121 GPS rows -> its row i maps onto second 2i.
    expect(value(frame, 'RPM', 0)).toBe(1000);
    expect(value(frame, 'RPM', 10)).toBe(1050);
    expect(value(frame, 'RPM', 20)).toBe(1100);
    expect(value(frame, 'RPM', 1200)).toBe(7000);
    // Engine Data is 1 Hz (500 + row), so one second on the grid is one row.
    expect(value(frame, 'Engine Data', 0)).toBe(500);
    expect(value(frame, 'Engine Data', 10)).toBe(501);
    // A second column of the same table becomes its own constant channel.
    expect(value(frame, 'Engine Data_Oil Pressure', 0)).toBe(3);
    expect(value(frame, 'GPS Latitude', 0)).toBe(45.62);
    expect(value(frame, 'GPS Latitude', 100)).toBeCloseTo(45.621, 9);
  });

  it('propagates SQL NULL as NaN without poisoning the neighbours', () => {
    // "Throttle Pos" is NULL in rows 60 and 61, so every frame strictly between
    // t = 59 s and t = 62 s interpolates through a NaN.
    expect(value(frame, 'Throttle Pos', 590)).toBe(0.8);
    expect(value(frame, 'Throttle Pos', 591)).toBeNaN();
    expect(value(frame, 'Throttle Pos', 599)).toBeNaN();
    expect(value(frame, 'Throttle Pos', 600)).toBeNaN();
    expect(value(frame, 'Throttle Pos', 619)).toBeNaN();
    expect(value(frame, 'Throttle Pos', 620)).toBe(0.8);
  });

  it('forward fills sparse channels and zeroes WheelsDetached', () => {
    // TyresCompound events: (10, 2), (75, 3).
    expect(value(frame, 'TyresCompound', 0)).toBeNaN();
    expect(value(frame, 'TyresCompound', 99)).toBeNaN();
    expect(value(frame, 'TyresCompound', 100)).toBe(2);
    expect(value(frame, 'TyresCompound', 749)).toBe(2);
    expect(value(frame, 'TyresCompound', 750)).toBe(3);
    expect(value(frame, 'TyresCompound', 1200)).toBe(3);
    // WheelsDetached has one event at 40 s; the NaNs before it are replaced by 0.
    expect(value(frame, 'WheelsDetached', 0)).toBe(0);
    expect(value(frame, 'WheelsDetached', 399)).toBe(0);
    expect(value(frame, 'WheelsDetached', 400)).toBe(1);
    expect(value(frame, 'WheelsDetached', 1200)).toBe(1);
  });

  it('treats 1/0 events of a pulse channel as start/stop', () => {
    // TCCut events at 20.04 and 20.05 both round onto frame 201, so the stop is pushed to
    // the following frame instead of erasing the pulse.
    expect(value(frame, 'TCCut', 200)).toBeNaN();
    expect(value(frame, 'TCCut', 201)).toBe(1);
    expect(value(frame, 'TCCut', 202)).toBe(0);
    expect(value(frame, 'TCCut', 1200)).toBe(0);
  });

  it('keeps non-sparse event channels empty between events', () => {
    // "In Pits" is not in the sparse set, so only the aligned frames carry values.
    expect(value(frame, 'In Pits', 0)).toBeNaN();
    expect(value(frame, 'In Pits', 299)).toBeNaN();
    expect(value(frame, 'In Pits', 300)).toBe(1);
    expect(value(frame, 'In Pits', 340)).toBe(0);
    expect(value(frame, 'In Pits', 500)).toBeNaN();
    expect(value(frame, 'In Pits', 700)).toBe(1);
    expect(value(frame, 'In Pits', 740)).toBe(0);
  });

  it('fuses the extra columns of an event table separately', () => {
    // Setup rows: (1.5, 1.0/0.0), (33.5, NULL/0.2), (50.5, 0.9/0.3).
    expect(value(frame, 'Setup_Throttle', 0)).toBeNaN();
    expect(value(frame, 'Setup_Throttle', 15)).toBe(1);
    expect(value(frame, 'Setup_Throttle', 335)).toBeNaN();
    expect(value(frame, 'Setup_Brake', 335)).toBe(0.2);
    expect(value(frame, 'Setup_Brake', 334)).toBeNaN();
    expect(value(frame, 'Setup_Throttle', 505)).toBe(0.9);
  });

  it('places wheel events on the frame and fills each wheel on its own', () => {
    // Wheel Speed is not sparse: only the two event frames have values.
    expect(wheel(frame, 'Wheel Speed', 0, 0)).toBeNaN();
    expect(wheel(frame, 'Wheel Speed', 50, 0)).toBe(66);
    expect(wheel(frame, 'Wheel Speed', 50, 2)).toBe(54);
    expect(wheel(frame, 'Wheel Speed', 600, 0)).toBe(72);
    // A NULL inside a wheel row stays NaN.
    expect(wheel(frame, 'Tyre Loads', 130, 0)).toBe(1000);
    expect(wheel(frame, 'Tyre Loads', 130, 1)).toBeNaN();
    expect(wheel(frame, 'Tyre Loads', 130, 3)).toBe(900);
    // Wheel ABS is sparse: forward fill per wheel column, not per frame row.
    expect(wheel(frame, 'Wheel ABS', 139, 0)).toBeNaN();
    expect(wheel(frame, 'Wheel ABS', 140, 0)).toBe(1);
    expect(wheel(frame, 'Wheel ABS', 140, 1)).toBe(0);
    expect(wheel(frame, 'Wheel ABS', 304, 0)).toBe(1);
    expect(wheel(frame, 'Wheel ABS', 305, 0)).toBe(0);
    expect(wheel(frame, 'Wheel ABS', 305, 1)).toBe(1);
  });

  it('derives ABS and TC from the worst wheel, replacing the event tables', () => {
    // Wheel ABS after forward fill: NaN before 140, a 1 somewhere in 140..504, then all 0.
    expect(value(frame, 'ABS', 0)).toBeNaN();
    expect(value(frame, 'ABS', 139)).toBeNaN();
    expect(value(frame, 'ABS', 140)).toBe(1);
    expect(value(frame, 'ABS', 305)).toBe(1);
    expect(value(frame, 'ABS', 504)).toBe(1);
    expect(value(frame, 'ABS', 505)).toBe(0);
    expect(value(frame, 'ABS', 1200)).toBe(0);
    // No "Wheel TC" table exists, so the override falls back to the "WheelTC" name.
    expect(value(frame, 'TC', 0)).toBeNaN();
    expect(value(frame, 'TC', 219)).toBeNaN();
    expect(value(frame, 'TC', 220)).toBe(0);
    expect(value(frame, 'TC', 454)).toBe(0);
    expect(value(frame, 'TC', 455)).toBe(1);
    expect(value(frame, 'TC', 1200)).toBe(1);
  });

  it('negates the left wheels when deriving the slip ratio', () => {
    // Slip = (wheelSpeed - groundSpeed) / max(groundSpeed, 0.5), with groundSpeed = 60 m/s.
    // Frame 50 takes the Wheel Speed event at t = 5 s: [66, 60, 54, 60].
    expect(wheel(frame, 'Slip Ratio', 50, 0)).toBeCloseTo(-0.1, 9);
    expect(wheel(frame, 'Slip Ratio', 50, 1)).toBeCloseTo(0, 9);
    expect(wheel(frame, 'Slip Ratio', 50, 2)).toBeCloseTo(0.1, 9);
    expect(wheel(frame, 'Slip Ratio', 50, 3)).toBeCloseTo(0, 9);
    expect(wheel(frame, 'Slip Ratio', 600, 0)).toBeCloseTo(-0.2, 9);
    expect(wheel(frame, 'Slip Ratio', 600, 2)).toBeCloseTo(0.2, 9);
    // Frames without a wheel-speed sample stay NaN (the source is not forward filled).
    expect(wheel(frame, 'Slip Ratio', 0, 0)).toBeNaN();
  });

  it('splits tyre temperatures into inside and outside flanks', () => {
    // Left [80,82,84,86], right [90,92,94,96] at t = 20 s. Wheels 0 and 2 are the left
    // tyres of the car, whose outside flank is the right-hand reading.
    expect(wheel(frame, 'TyresTempInside', 200, 0)).toBe(90);
    expect(wheel(frame, 'TyresTempInside', 200, 1)).toBe(82);
    expect(wheel(frame, 'TyresTempInside', 200, 2)).toBe(94);
    expect(wheel(frame, 'TyresTempInside', 200, 3)).toBe(86);
    expect(wheel(frame, 'TyresTempOutside', 200, 0)).toBe(80);
    expect(wheel(frame, 'TyresTempOutside', 200, 1)).toBe(92);
    expect(wheel(frame, 'TyresTempOutside', 200, 2)).toBe(84);
    expect(wheel(frame, 'TyresTempOutside', 200, 3)).toBe(96);
    expect(wheel(frame, 'TyresTempInside', 955, 0)).toBe(95);
    expect(wheel(frame, 'TyresTempOutside', 955, 3)).toBe(101);
    expect(wheel(frame, 'TyresTempInside', 0, 0)).toBeNaN();
  });

  it('flips the suspension travel sign in place', () => {
    // Susp Pos rows are (-0.5, 0.5, -1.0, 1.5); the channel keeps its slot in the map.
    expect(wheel(frame, 'Susp Pos', 0, 0)).toBe(0.5);
    expect(wheel(frame, 'Susp Pos', 0, 1)).toBe(-0.5);
    expect(wheel(frame, 'Susp Pos', 0, 2)).toBe(1);
    expect(wheel(frame, 'Susp Pos', 0, 3)).toBe(-1.5);
    expect(wheel(frame, 'Susp Pos', 1200, 0)).toBe(0.5);
    expect(Array.from(frame.channels.keys()).indexOf('Susp Pos')).toBe(15);
  });

  it('calibrates the steering angle with the car steering lock', () => {
    // CarName "United Autosports" -> LMGT3 McLaren with a 540 deg lock.
    // Steering Pos stays within [-0.25, 0.5], so the -1..1 signal is scaled by 540/2 = 270.
    expect(value(frame, 'Steering Pos', 0)).toBe(0.5);
    expect(value(frame, 'Steering Angle', 0)).toBe(135);
    // Odd rows of the fixture hold -0.25, i.e. -67.5 deg at t = 1 s.
    expect(value(frame, 'Steering Angle', 10)).toBe(-67.5);
    // t = 0.1 s interpolates 0.5 -> -0.25 (0.425), which is 114.75 deg.
    expect(value(frame, 'Steering Angle', 1)).toBeCloseTo(114.75, 9);
  });

  it('fuses the elevation from the normalised distance', () => {
    const z = channelOf(frame, 'WorldPosZ');
    expect(z?.width).toBe(1);
    expect(z?.data.length).toBe(1201);
    // Lap Dist covers 0..2639 m and the Silverstone National profile runs 150.5..155.8 m,
    // so every fused sample - a convex combination of profile altitudes - stays inside
    // that band, and none of them is NaN (no distance is NaN once each lap restarts at 0).
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let nanSamples = 0;
    for (const sample of z?.data ?? new Float64Array()) {
      if (Number.isNaN(sample)) {
        nanSamples++;
      } else {
        min = Math.min(min, sample);
        max = Math.max(max, sample);
      }
    }
    expect(nanSamples).toBe(0);
    expect(min).toBeGreaterThanOrEqual(150.5);
    expect(max).toBeLessThanOrEqual(155.8);
    expect(max).toBeGreaterThan(min);
    // t = 0 sits 100 m into the lap, on the 0 -> 380 m ramp: 155 + 100/380 * 0.8 = 155.2105.
    // Its 40-wide window averages that with the samples up to Lap Dist = 214 m
    // (155 + 214/380 * 0.8 = 155.4505), so the result is pinned between the two.
    expect(z?.data[0]).toBeGreaterThanOrEqual(155 + (100 / 380) * 0.8 - 1e-9);
    expect(z?.data[0]).toBeLessThanOrEqual(155 + (214 / 380) * 0.8 + 1e-9);
  });

  it('carries sparse channels across a stint boundary when trimming', async () => {
    const trimmed = await engine.fuse(fixture.database, new FusionOptions(10, 70, 120));
    // 10 Hz over 50 s -> 501 frames starting on the trim point.
    expect(trimmed.time.length).toBe(501);
    expect(trimmed.time[0]).toBe(70);
    expect(trimmed.time[500]).toBe(120);
    expect(Array.from(trimmed.channels.keys())).toEqual([
      'Time',
      'Lap',
      'Lap Dist',
      'Gear',
      // ABS survives the trim only because the carry-over event is injected, so the
      // channel is still created in its SHOW TABLES slot and replaced there later.
      'ABS',
      'Engine Data',
      'Engine Data_Oil Pressure',
      'GPS Latitude',
      'GPS Longitude',
      'Ground Speed',
      'In Pits',
      'RPM',
      'Steering Pos',
      'Susp Pos',
      'TCCut',
      'Throttle Pos',
      'TyresCompound',
      'TyresTempCentre',
      'TyresTempLeft',
      'TyresTempRight',
      'Wheel ABS',
      'WheelTC',
      'WheelsDetached',
      'Steering Angle',
      'WorldPosZ',
      'TyresTempInside',
      'TyresTempOutside',
      // TC is appended: no `TC` table exists, so the wheel override creates it last.
      'TC',
    ]);

    // The last event before the trim is re-injected at the trim timestamp, so the first
    // frame already knows the compound fitted during the previous stint (event at 10 s).
    expect(value(trimmed, 'TyresCompound', 0)).toBe(2);
    expect(value(trimmed, 'TyresCompound', 49)).toBe(2);
    expect(value(trimmed, 'TyresCompound', 50)).toBe(3);
    expect(value(trimmed, 'WheelsDetached', 0)).toBe(1);
    // TCCut's last pre-trim event was a stop, carried as 0 rather than left NaN.
    expect(value(trimmed, 'TCCut', 0)).toBe(0);
    // Wheel tables carry all four values: the last Wheel ABS row was [0,0,0,0].
    expect(value(trimmed, 'ABS', 0)).toBe(0);
    expect(value(trimmed, 'ABS', 500)).toBe(0);
    expect(value(trimmed, 'TC', 0)).toBe(1);

    // Everything outside the window is dropped: Wheel Speed had no event in [70, 120] and
    // is not sparse, so neither it nor the derived Slip Ratio survives.
    expect(hasChannel(trimmed, 'Wheel Speed')).toBe(false);
    expect(hasChannel(trimmed, 'Slip Ratio')).toBe(false);
    expect(hasChannel(trimmed, 'Tyre Loads')).toBe(false);
    expect(hasChannel(trimmed, 'Setup_Throttle')).toBe(false);
    expect(wheel(trimmed, 'TyresTempInside', 255, 0)).toBe(95);

    // The lap index still counts from the session start, and the distance restarts.
    expect(value(trimmed, 'Lap', 0)).toBe(2);
    expect(value(trimmed, 'Lap', 500)).toBe(2);
    expect(value(trimmed, 'Lap Dist', 0)).toBe(0);
    expect(value(trimmed, 'Lap Dist', 500)).toBeCloseTo(2639, 6);
    // Gear as-ofs from before the trim; RPM still reads the full frame table.
    expect(value(trimmed, 'Gear', 0)).toBe(5);
    expect(value(trimmed, 'Gear', 80)).toBe(2);
    expect(value(trimmed, 'RPM', 0)).toBe(4500);
    // In Pits is not sparse, so only its events inside the window land on the grid.
    expect(value(trimmed, 'In Pits', 0)).toBe(1);
    expect(value(trimmed, 'In Pits', 1)).toBeNaN();
  });

  it('falls back to GPS Speed when Ground Speed is missing', async () => {
    const fallbackFixture = await createFusionFixture({
      omitTables: ['Ground Speed'],
      databaseName: 'no-ground-speed.duckdb',
    });
    try {
      const fallback = await engine.fuse(fallbackFixture.database, FusionOptions.of(10));
      expect(hasChannel(fallback, 'Ground Speed')).toBe(false);
      // GPS Speed already holds 60 m/s, so the integrated distance is unchanged.
      for (const at of [0, 299, 300, 699, 700, 1200]) {
        expect(value(fallback, 'Lap Dist', at)).toBeCloseTo(value(frame, 'Lap Dist', at), 6);
      }
      expect(wheel(fallback, 'Slip Ratio', 50, 0)).toBeCloseTo(-0.1, 9);
    } finally {
      fallbackFixture.dispose();
    }
  });

  it('wraps any fusion failure in the same message as Java', async () => {
    const dir = makeTempDir('lmutl-fusion-empty-');
    const database = path.join(dir, 'empty.duckdb');
    try {
      await writeDatabase(database, ['CREATE TABLE "GPS Time" (value DOUBLE)']);
      await expect(engine.fuse(database, FusionOptions.of(10))).rejects.toThrow(
        'Telemetry fusion failed: GPS Time table is empty.',
      );
      await expect(
        engine.fuse(path.join(dir, 'does-not-exist.duckdb'), FusionOptions.of(10)),
      ).rejects.toThrow(/^Telemetry fusion failed: /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the fixture statements reusable', () => {
    // The helper is also the fixture for the LapService/Telemetry ports; make sure the
    // overrides compose instead of replacing.
    const statements = fusionFixtureStatements({
      omitTables: ['RPM'],
      metadata: { TrackName: 'Monza' },
    });
    expect(statements.some((sql) => sql.includes('CREATE TABLE "RPM"'))).toBe(false);
    expect(statements.at(-1)).toContain("'TrackName', 'Monza'");
    expect(statements.at(-1)).toContain("'CarClass', 'LMGT3'");
  });
});
