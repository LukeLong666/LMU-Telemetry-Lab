import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDbConnectionFactory, type DuckDbSession } from '../../../src/infra/duckdb/connection.js';
import * as DuckDbReads from '../../../src/infra/duckdb/reads.js';
import { createSessionFixture, makeTempDir, runStatements, type TestDatabase } from './fixture.js';

const factory = new DuckDbConnectionFactory();
let fixture: TestDatabase;
let database = '';

beforeAll(async () => {
  fixture = await createSessionFixture();
  database = fixture.database;
}, 60_000);

afterAll(() => {
  fixture?.dispose();
});

/** Runs `read` against the fixture on a fresh read-only connection. */
async function query<T>(read: (session: DuckDbSession) => Promise<T>): Promise<T> {
  return factory.withConnection(database, read);
}

describe('DuckDbConnectionFactory', () => {
  it('opens a session file read-only and reads through it', async () => {
    const session = await factory.open(database);
    try {
      expect(session.database).toBe(path.resolve(database).replace(/\\/g, '/'));
      expect(session.isClosed).toBe(false);
      const names = await DuckDbReads.tableNames(session.connection);
      expect(names).toContain('GPS Time');
    } finally {
      session.close();
    }
    expect(session.isClosed).toBe(true);
  });

  it('rejects writes on a read-only session', async () => {
    await query(async (session) => {
      await expect(session.run('CREATE TABLE nope (a INT)')).rejects.toThrow(/read-only|Cannot execute statement/);
    });
  });

  it('is idempotent on close', async () => {
    const session = await factory.open(database);
    session.close();
    expect(() => session.close()).not.toThrow();
  });

  it('releases the file handle so the database can be renamed', async () => {
    const dir = makeTempDir('lmutl-duckdb-handle-');
    const file = path.join(dir, 'handle.duckdb');
    await runStatements(file, ['CREATE TABLE t (value DOUBLE)', 'INSERT INTO t VALUES (1.0)']);

    const session = await factory.open(file);
    await DuckDbReads.readValues(session.connection, 't');
    session.close();

    const renamed = path.join(dir, 'renamed.duckdb');
    expect(() => fs.renameSync(file, renamed)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('releases the file handle when the callback throws', async () => {
    const dir = makeTempDir('lmutl-duckdb-throw-');
    const file = path.join(dir, 'throw.duckdb');
    await runStatements(file, ['CREATE TABLE t (value DOUBLE)', 'INSERT INTO t VALUES (1.0)']);

    await expect(
      factory.withConnection(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const renamed = path.join(dir, 'renamed.duckdb');
    expect(() => fs.renameSync(file, renamed)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to open a missing file', async () => {
    const dir = makeTempDir('lmutl-duckdb-missing-');
    await expect(factory.open(path.join(dir, 'absent.duckdb'))).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens read-write for the export path', async () => {
    const dir = makeTempDir('lmutl-duckdb-write-');
    const file = path.join(dir, 'out.duckdb');
    await factory.withReadWriteConnection(file, async (session) => {
      await session.run('CREATE TABLE t (value DOUBLE)');
      await session.run('INSERT INTO t VALUES (2.5)');
    });
    const values = await factory.withConnection(file, (session) =>
      DuckDbReads.readValues(session.connection, 't'),
    );
    expect(Array.from(values)).toEqual([2.5]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('DuckDbReads value conversion', () => {
  it('maps DOUBLE rows, keeping NULL as NaN', async () => {
    const values = await query((session) => DuckDbReads.readValues(session.connection, 'GPS Time'));
    expect(values).toBeInstanceOf(Float64Array);
    expect(Array.from(values)).toEqual([10.5, 20.25, Number.NaN, 30.75]);
  });

  it('maps INTEGER and BOOLEAN columns to numbers', async () => {
    await query(async (session) => {
      const gear = await DuckDbReads.readColumn(session.connection, 'Gear', 'value');
      expect(Array.from(gear)).toEqual([3, Number.NaN, 5]);
      const events = await DuckDbReads.readEvents(session.connection, 'In Pits');
      expect(events).toEqual([
        { ts: 11, value: 1 },
        { ts: 26, value: 0 },
      ]);
    });
  });

  it('maps BIGINT columns through Number(bigint)', async () => {
    const values = await query((session) => DuckDbReads.readValues(session.connection, 'Counters'));
    expect(Array.from(values)).toEqual([42, Number.NaN, -7]);
  });

  it('maps DECIMAL columns like JDBC BigDecimal values', async () => {
    await query(async (session) => {
      const values = await DuckDbReads.readValues(session.connection, 'Decimals');
      expect(Array.from(values)).toEqual([1.9, -1.9, Number.NaN]);
      expect(await DuckDbReads.scalarInt(session.connection, 'SELECT value FROM "Decimals" LIMIT 1')).toBe(1);
      expect(
        await DuckDbReads.scalarInt(session.connection, 'SELECT value FROM "Decimals" WHERE value < 0'),
      ).toBe(-1);
    });
  });

  it('parses VARCHAR values the way Java parses them', async () => {
    const values = await query((session) => DuckDbReads.readValues(session.connection, 'Strings'));
    expect(Array.from(values)).toEqual([1.5, 7, Number.NaN, 1000, Number.NaN]);
  });

  it('returns text for SHOW TABLES / DESCRIBE columns', async () => {
    await query(async (session) => {
      const names = await DuckDbReads.tableNames(session.connection);
      expect(new Set(names)).toContain('Tyre Loads');
      expect(await DuckDbReads.columns(session.connection, 'Setup')).toEqual(['ts', 'Throttle', 'Brake']);
    });
  });
});

describe('DuckDbReads event reads', () => {
  it('reads events in ts order and skips unparseable ts', async () => {
    await query(async (session) => {
      expect(await DuckDbReads.readEvents(session.connection, 'Lap')).toEqual([
        { ts: 12, value: 1 },
        { ts: 25, value: 2 },
      ]);
      expect(await DuckDbReads.readEvents(session.connection, 'Odd')).toEqual([{ ts: 2.5, value: 2 }]);
      expect(await DuckDbReads.readEventsColumn(session.connection, 'Setup', 'Throttle')).toEqual([
        { ts: 1, value: 0.8 },
        { ts: 2, value: 0.2 },
      ]);
    });
  });

  it('collapses a missing event table to empty, like readEventsOrEmpty', async () => {
    await query(async (session) => {
      expect(await DuckDbReads.readEventsOrEmpty(session.connection, 'No Such Table')).toEqual([]);
      expect(Array.from(await DuckDbReads.readValuesOrEmpty(session.connection, 'No Such Table'))).toEqual([]);
    });
  });

  it('reads the last event at or before a timestamp ($1 bind)', async () => {
    await query(async (session) => {
      expect(await DuckDbReads.lastEventBefore(session.connection, 'Lap', 24.5)).toEqual({ ts: 12, value: 1 });
      expect(await DuckDbReads.lastEventBefore(session.connection, 'Lap', 25)).toEqual({ ts: 25, value: 2 });
      expect(await DuckDbReads.lastEventBefore(session.connection, 'Lap', 1)).toBeNull();
      expect(await DuckDbReads.lastEventBefore(session.connection, 'No Such Table', 1)).toBeNull();
    });
  });

  it('reads wheel events', async () => {
    await query(async (session) => {
      const wheels = await DuckDbReads.readEventWheels(session.connection, 'Tyre Loads');
      expect(wheels).toHaveLength(3);
      expect(wheels[1].ts).toBe(13);
      expect(Array.from(wheels[1].values)).toEqual([5, Number.NaN, 7, 8]);

      const last = await DuckDbReads.lastEventWheelBefore(session.connection, 'Tyre Loads', 26.5);
      expect(last?.ts).toBe(13);
      expect(Array.from(last?.values ?? [])).toEqual([5, Number.NaN, 7, 8]);

      const columns = await DuckDbReads.readWheelValues(session.connection, 'Tyre Loads');
      expect(columns).toHaveLength(4);
      expect(columns.map((column) => column.length)).toEqual([3, 3, 3, 3]);
      expect(Array.from(columns[0])).toEqual([1, 5, 9]);
      expect(Array.from(columns[1])).toEqual([2, Number.NaN, 10]);
      expect(Array.from(columns[3])).toEqual([4, 8, 12]);
    });
  });

  it('returns null (not 0) for scalar NULLs', async () => {
    await query(async (session) => {
      expect(await DuckDbReads.scalarDouble(session.connection, 'SELECT MIN(value) FROM "GPS Time"')).toBe(10.5);
      expect(await DuckDbReads.scalarDouble(session.connection, 'SELECT MAX(value) FROM "GPS Time"')).toBe(30.75);
      expect(
        await DuckDbReads.scalarDouble(session.connection, 'SELECT value FROM "Gear" WHERE ts = 2.0'),
      ).toBeNull();
      expect(
        await DuckDbReads.scalarDouble(session.connection, "SELECT value FROM \"Strings\" WHERE value = 'abc'"),
      ).toBeNull();
      expect(await DuckDbReads.scalarDouble(session.connection, 'SELECT value FROM "Nope"')).toBeNull();
      expect(await DuckDbReads.scalarDouble(session.connection, 'SELECT value FROM "GPS Time" WHERE 1 = 0')).toBeNull();

      expect(await DuckDbReads.scalarInt(session.connection, 'SELECT COUNT(*) FROM "GPS Time"')).toBe(4);
      expect(await DuckDbReads.scalarInt(session.connection, 'SELECT value FROM "Gear" WHERE ts = 1.0')).toBe(3);
      expect(await DuckDbReads.scalarInt(session.connection, 'SELECT 1.9')).toBe(1);
      expect(await DuckDbReads.scalarInt(session.connection, "SELECT 'abc'")).toBeNull();
      expect(await DuckDbReads.scalarInt(session.connection, 'SELECT value FROM "Counters" WHERE value = 42')).toBe(42);
    });
  });
});

describe('DuckDbReads streaming reads', () => {
  it('streams a frame column chunk by chunk', async () => {
    const chunkSizes: number[] = [];
    const offsets: number[] = [];
    const streamed: number[] = [];
    const total = await query((session) =>
      DuckDbReads.streamValues(session.connection, 'Frames', (chunk) => {
        chunkSizes.push(chunk.values.length);
        offsets.push(chunk.firstRow);
        for (const value of chunk.values) streamed.push(value);
      }),
    );

    expect(total).toBe(5000);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(chunkSizes.reduce((sum, size) => sum + size, 0)).toBe(5000);
    expect(chunkSizes[0]).toBe(2048);
    expect(offsets).toEqual([0, 2048, 4096]);
    expect(streamed.length).toBe(5000);

    const materialized = await query((session) => DuckDbReads.readValues(session.connection, 'Frames'));
    expect(Array.from(materialized)).toEqual(streamed);
    expect(materialized.length).toBe(5000);
  }, 30_000);

  it('streams a named column and reports awaiting sinks', async () => {
    let seen = 0;
    const total = await query((session) =>
      DuckDbReads.streamColumn(session.connection, 'Gear', 'value', async (chunk) => {
        await Promise.resolve();
        seen += chunk.values.length;
      }),
    );
    expect(total).toBe(3);
    expect(seen).toBe(3);
  });

  it('streams raw rows for arbitrary SQL', async () => {
    const rows: (readonly unknown[])[] = [];
    const count = await query((session) =>
      DuckDbReads.streamRows(session.connection, 'SELECT ts, value FROM "Lap" ORDER BY ts', (row, index) => {
        rows.push([...row]);
        expect(index).toBe(rows.length - 1);
      }),
    );
    expect(count).toBe(2);
    expect(rows).toEqual([[12, 1], [25, 2]]);
  });

  it('closes the streamed result so the next statement can run', async () => {
    await query(async (session) => {
      await DuckDbReads.streamValues(session.connection, 'Frames', () => undefined);
      expect(await DuckDbReads.tableNames(session.connection)).toContain('Frames');
    });
  }, 30_000);
});
