import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDbConnectionFactory, type DuckDbSession } from '../../../src/infra/duckdb/connection.js';
import * as LapBoundaryResolver from '../../../src/infra/duckdb/lap-boundaries.js';
import {
  createSessionFixture,
  makeTempDir,
  runStatements,
  type TestDatabase,
} from './fixture.js';

const factory = new DuckDbConnectionFactory();
let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await createSessionFixture();
}, 60_000);

afterAll(() => {
  fixture?.dispose();
});

/** Builds a throwaway database, resolves its boundaries, always cleans up. */
async function resolveFor(statements: readonly string[]): Promise<LapBoundaryResolver.LapBoundaries> {
  const dir = makeTempDir('lmutl-duckdb-boundaries-');
  try {
    const database = path.join(dir, 'session.duckdb');
    await runStatements(database, statements);
    return await factory.withConnection(database, (session: DuckDbSession) =>
      LapBoundaryResolver.resolve(session.connection),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('LapBoundaryResolver.resolve', () => {
  it('uses the session span plus the lap start events', async () => {
    const result = await factory.withConnection(fixture.database, (session) =>
      LapBoundaryResolver.resolve(session.connection),
    );
    expect(result.sessionStart).toBe(10.5);
    expect(result.sessionEnd).toBe(30.75);
    // GPS Time spans 10.5..30.75; Lap starts at 12 and 25. The calculated out-lap
    // start (24 - 12 = 12) is not > firstLapStart + 1, so it is dropped, and the
    // session start is prepended because 12 - 10.5 > 1.
    expect(result.boundaries).toEqual([10.5, 12, 25]);
    // The 0.0 lap time is filtered out.
    expect(result.lapTimes).toEqual([{ ts: 24, value: 12 }]);
  });

  it('keeps a calculated out-lap start and de-duplicates boundaries', async () => {
    const result = await resolveFor([
      'CREATE TABLE "GPS Time" (value DOUBLE)',
      'INSERT INTO "GPS Time" VALUES (0.0), (100.0)',
      'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap" VALUES (10.0, 1.0), (50.0, 2.0), (50.0, 3.0)',
      'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap Time" VALUES (30.0, 15.0), (55.0, -1.0)',
    ]);
    // calcStart = 30 - 15 = 15: inside (10 + 1, 50 - 1), so it is kept.
    expect(result.boundaries).toEqual([0, 10, 15, 50]);
    expect(result.lapTimes).toEqual([{ ts: 30, value: 15 }]);
  });

  it('adds a calculated out-lap start when there is a single lap event', async () => {
    const result = await resolveFor([
      'CREATE TABLE "GPS Time" (value DOUBLE)',
      'INSERT INTO "GPS Time" VALUES (0.0), (100.0)',
      'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap" VALUES (50.0, 1.0)',
      'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
      'INSERT INTO "Lap Time" VALUES (100.0, 20.0)',
    ]);
    expect(result.boundaries).toEqual([0, 50, 80]);
  });

  it('falls back to the session start without lap events', async () => {
    const result = await resolveFor([
      'CREATE TABLE "GPS Time" (value DOUBLE)',
      'INSERT INTO "GPS Time" VALUES (5.0), (40.0)',
      'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)',
      'CREATE TABLE "Lap Time" (ts DOUBLE, value DOUBLE)',
    ]);
    expect(result.boundaries).toEqual([5]);
    expect(result.lapTimes).toEqual([]);
    expect(result.sessionEnd).toBe(40);
  });

  it('throws when the session has no GPS timestamps', async () => {
    await expect(
      resolveFor(['CREATE TABLE "GPS Time" (value DOUBLE)', 'CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)']),
    ).rejects.toThrow('GPS Time table is empty.');
  });

  it('throws the same way when the GPS Time table is missing', async () => {
    await expect(
      resolveFor(['CREATE TABLE "Lap" (ts DOUBLE, value DOUBLE)']),
    ).rejects.toThrow('GPS Time table is empty.');
  });
});
