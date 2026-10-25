import {
  DOUBLE,
  DuckDBDecimalValue,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import type { BindTypes, BindValues } from './connection.js';

/** DuckDbReads.java: every read the backend performs against a session database. */

/** Java `DuckDbReads.Event` - an event table row (`ts`, `value`). */
export interface Event {
  readonly ts: number;
  readonly value: number;
}

/** Java `DuckDbReads.EventWheel` - a per-wheel event row (`ts`, `value1`..`value4`). */
export interface EventWheel {
  readonly ts: number;
  readonly values: Float64Array;
}

/** One streamed slice of a single-value column: at most a DuckDB chunk (2048 rows). */
export interface ValueChunk {
  readonly values: Float64Array;
  /** Absolute index of the first row in this chunk, in result order. */
  readonly firstRow: number;
}

/** Called once per streamed chunk; awaiting it applies back pressure to the query. */
export type ValueChunkSink = (chunk: ValueChunk) => void | Promise<void>;

/** Called once per streamed row; values are raw `DuckDBValue`s (null for SQL NULL). */
export type RowSink = (row: readonly DuckDBValue[], rowIndex: number) => void | Promise<void>;

/**
 * DuckDB tables mix DOUBLE, INTEGER, BOOLEAN and VARCHAR values, so a plain
 * "getDouble" would throw on booleans. This converts every numeric-ish value the
 * way pandas does for the Python oracle (Java `DuckDbReads.number`).
 *
 * SQL NULL -> NaN, BOOLEAN -> 1/0, BIGINT/HUGEINT -> Number(bigint), DECIMAL and
 * other wrapper values -> parsed from their text, unparseable -> NaN.
 */
export function toNumber(value: DuckDBValue): number {
  if (value === null) return Number.NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const text = toText(value);
  if (text === null) return Number.NaN;
  return parseDouble(text);
}

/** Java `DuckDbReads.numberOrNull`: null for SQL NULL and for non-numeric text. */
export function toNumberOrNull(value: DuckDBValue): number | null {
  if (value === null) return null;
  const number = toNumber(value);
  return Number.isNaN(number) && typeof value !== 'boolean' ? null : number;
}

/** JDBC `getString`: SQL NULL stays null, everything else keeps its DuckDB text form. */
export function toText(value: DuckDBValue): string | null {
  return value === null ? null : String(value);
}

/** Java `Integer.parseInt` semantics: digits only, no exponents, no decimals. */
function toIntegerOrNull(value: DuckDBValue): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof DuckDBDecimalValue) {
    // JDBC returned a BigDecimal here, i.e. the Number branch of the Java code.
    const parsed = Number(value.toString());
    return Number.isNaN(parsed) ? null : Math.trunc(parsed);
  }
  const text = toText(value);
  if (text === null || !/^[+-]?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isNaN(parsed) ? null : Math.trunc(parsed);
}

function parseDouble(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return Number.NaN;
  // Java's Double.parseDouble tolerates a trailing type suffix; Number() does not.
  const withoutSuffix = /[dDfF]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
  const parsed = Number(withoutSuffix);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** Streams a single-statement query and hands every row to `onRow`, chunk by chunk. */
async function forEachRow(
  connection: DuckDBConnection,
  sql: string,
  onRow: RowSink,
): Promise<number> {
  const result = await connection.stream(sql);
  let rowIndex = 0;
  try {
    for await (const chunk of result) {
      for (const row of chunk.getRows()) {
        await onRow(row, rowIndex);
        rowIndex += 1;
      }
    }
  } finally {
    result.closeSync();
  }
  return rowIndex;
}

/** Streams a single-value column and converts it one chunk at a time. */
async function forEachValueChunk(
  connection: DuckDBConnection,
  sql: string,
  onChunk: ValueChunkSink,
): Promise<number> {
  const result = await connection.stream(sql);
  let rowCount = 0;
  try {
    for await (const chunk of result) {
      const column = chunk.getColumnValues(0);
      const values = new Float64Array(column.length);
      for (let index = 0; index < column.length; index += 1) {
        values[index] = toNumber(column[index]);
      }
      await onChunk({ values, firstRow: rowCount });
      rowCount += column.length;
    }
  } finally {
    result.closeSync();
  }
  return rowCount;
}

async function collectValues(
  connection: DuckDBConnection,
  sql: string,
): Promise<Float64Array> {
  const parts: Float64Array[] = [];
  const total = await forEachValueChunk(connection, sql, (chunk) => {
    parts.push(chunk.values);
  });
  const result = new Float64Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function quoteIdentifier(name: string): string {
  return `"${name}"`;
}

/**
 * Materialized one-shot query: the rows are copied out of the DuckDB result and
 * the result is closed before returning, mirroring Java's try-with-resources
 * around `Statement`/`ResultSet`.
 */
export async function readRows(
  connection: DuckDBConnection,
  sql: string,
  values?: BindValues,
  types?: BindTypes,
): Promise<DuckDBValue[][]> {
  const reader = await connection.runAndReadAll(sql, values, types);
  try {
    return reader.getRows();
  } finally {
    reader.closeSync();
  }
}

/** Java `readValues`: the whole `value` column of a frame table, in rowid order. */
export async function readValues(connection: DuckDBConnection, table: string): Promise<Float64Array> {
  return collectValues(connection, `SELECT value FROM ${quoteIdentifier(table)} ORDER BY rowid`);
}

/** Java `readValuesOrEmpty`: same query, missing/broken table collapses to empty. */
export async function readValuesOrEmpty(connection: DuckDBConnection, table: string): Promise<Float64Array> {
  try {
    return await readValues(connection, table);
  } catch {
    return new Float64Array(0);
  }
}

/**
 * Streaming `readValues` - the frame-sized variant for the telemetry endpoints.
 * `onChunk` receives one Float64Array per DuckDB chunk (2048 rows max) plus its
 * absolute row offset, and returns the number of rows streamed.
 */
export function streamValues(
  connection: DuckDBConnection,
  table: string,
  onChunk: ValueChunkSink,
): Promise<number> {
  return forEachValueChunk(
    connection,
    `SELECT value FROM ${quoteIdentifier(table)} ORDER BY rowid`,
    onChunk,
  );
}

/** Java `readColumn`: one named column of a frame table, in rowid order. */
export async function readColumn(
  connection: DuckDBConnection,
  table: string,
  column: string,
): Promise<Float64Array> {
  return collectValues(
    connection,
    `SELECT ${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} ORDER BY rowid`,
  );
}

/** Streaming `readColumn`, same chunk contract as `streamValues`. */
export function streamColumn(
  connection: DuckDBConnection,
  table: string,
  column: string,
  onChunk: ValueChunkSink,
): Promise<number> {
  return forEachValueChunk(
    connection,
    `SELECT ${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} ORDER BY rowid`,
    onChunk,
  );
}

/** Java `lastEventBefore`: last `ts <= timestamp`, or null when there is none. */
export async function lastEventBefore(
  connection: DuckDBConnection,
  table: string,
  timestamp: number,
): Promise<Event | null> {
  const sql = `SELECT ts, value FROM ${quoteIdentifier(table)} WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`;
  try {
    const rows = await readRows(connection, sql, [timestamp], [DOUBLE]);
    if (rows.length === 0) return null;
    const ts = toNumber(rows[0][0]);
    if (Number.isNaN(ts)) return null;
    return { ts, value: toNumber(rows[0][1]) };
  } catch {
    return null;
  }
}

/** Java `lastEventWheelBefore`: last `ts <= timestamp` for a 4-wheel event table. */
export async function lastEventWheelBefore(
  connection: DuckDBConnection,
  table: string,
  timestamp: number,
): Promise<EventWheel | null> {
  const sql = `SELECT ts, value1, value2, value3, value4 FROM ${quoteIdentifier(
    table,
  )} WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`;
  try {
    const rows = await readRows(connection, sql, [timestamp], [DOUBLE]);
    if (rows.length === 0) return null;
    const ts = toNumber(rows[0][0]);
    if (Number.isNaN(ts)) return null;
    const values = new Float64Array(4);
    for (let wheel = 0; wheel < 4; wheel += 1) {
      values[wheel] = toNumber(rows[0][wheel + 1]);
    }
    return { ts, values };
  } catch {
    return null;
  }
}

/** Java `readEvents`: every `ts`/`value` row in ts order, skipping rows without a ts. */
export async function readEvents(connection: DuckDBConnection, table: string): Promise<Event[]> {
  const events: Event[] = [];
  await forEachRow(connection, `SELECT ts, value FROM ${quoteIdentifier(table)} ORDER BY ts`, (row) => {
    const ts = toNumber(row[0]);
    if (Number.isNaN(ts)) return;
    events.push({ ts, value: toNumber(row[1]) });
  });
  return events;
}

/** Java `readEventsColumn`: same, but the value comes from a named column. */
export async function readEventsColumn(
  connection: DuckDBConnection,
  table: string,
  column: string,
): Promise<Event[]> {
  const events: Event[] = [];
  await forEachRow(
    connection,
    `SELECT ts, ${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} ORDER BY ts`,
    (row) => {
      const ts = toNumber(row[0]);
      if (Number.isNaN(ts)) return;
      events.push({ ts, value: toNumber(row[1]) });
    },
  );
  return events;
}

/** Java `readEventsOrEmpty`: missing/broken event table yields an empty list. */
export async function readEventsOrEmpty(connection: DuckDBConnection, table: string): Promise<Event[]> {
  try {
    return await readEvents(connection, table);
  } catch {
    return [];
  }
}

/** Java `readEventWheels`: `ts` plus the four wheel columns, in ts order. */
export async function readEventWheels(connection: DuckDBConnection, table: string): Promise<EventWheel[]> {
  const events: EventWheel[] = [];
  await forEachRow(
    connection,
    `SELECT ts, value1, value2, value3, value4 FROM ${quoteIdentifier(table)} ORDER BY ts`,
    (row) => {
      const ts = toNumber(row[0]);
      if (Number.isNaN(ts)) return;
      const values = new Float64Array(4);
      for (let wheel = 0; wheel < 4; wheel += 1) {
        values[wheel] = toNumber(row[wheel + 1]);
      }
      events.push({ ts, values });
    },
  );
  return events;
}

/**
 * Java `readWheelValues`: column-major wheel series, `[4][rows]` - `result[wheel][row]`,
 * ordered by rowid.
 */
export async function readWheelValues(connection: DuckDBConnection, table: string): Promise<Float64Array[]> {
  const perWheel: number[][] = [[], [], [], []];
  await forEachRow(
    connection,
    `SELECT value1, value2, value3, value4 FROM ${quoteIdentifier(table)} ORDER BY rowid`,
    (row) => {
      for (let wheel = 0; wheel < 4; wheel += 1) {
        perWheel[wheel].push(toNumber(row[wheel]));
      }
    },
  );
  return perWheel.map((wheel) => Float64Array.from(wheel));
}

/**
 * Generic row stream for the telemetry response writer: `sql` must be a single
 * statement; rows are handed over chunk by chunk and never materialized.
 */
export function streamRows(
  connection: DuckDBConnection,
  sql: string,
  onRow: RowSink,
): Promise<number> {
  return forEachRow(connection, sql, onRow);
}

/** Java `tableNames`: `SHOW TABLES`, first column only. */
export async function tableNames(connection: DuckDBConnection): Promise<string[]> {
  const rows = await readRows(connection, 'SHOW TABLES');
  return rows.map((row) => toText(row[0]) ?? '');
}

/** Java `columns`: `DESCRIBE "<table>"`, the `column_name` column. */
export async function columns(connection: DuckDBConnection, table: string): Promise<string[]> {
  const rows = await readRows(connection, `DESCRIBE ${quoteIdentifier(table)}`);
  return rows.map((row) => toText(row[0]) ?? '');
}

/** Java `scalarDouble`: first row, first column, nullable. */
export async function scalarDouble(connection: DuckDBConnection, sql: string): Promise<number | null> {
  try {
    const rows = await readRows(connection, sql);
    if (rows.length === 0) return null;
    return toNumberOrNull(rows[0][0]);
  } catch {
    return null;
  }
}

/** Java `scalarInt`: first row, first column, truncated to an integer, nullable. */
export async function scalarInt(connection: DuckDBConnection, sql: string): Promise<number | null> {
  try {
    const rows = await readRows(connection, sql);
    if (rows.length === 0) return null;
    return toIntegerOrNull(rows[0][0]);
  } catch {
    return null;
  }
}
