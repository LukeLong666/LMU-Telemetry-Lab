/**
 * Ports backend-java/src/main/java/com/lmutl/application/LapExportService.java (256 lines).
 *
 * Produces a standalone `.duckdb` file holding exactly one lap: the output database is
 * created in the profile `cache` directory, the session file is `ATTACH`ed read-only as
 * `src`, and every source table is re-created through a CTAS that slices it by the target
 * lap's time range. The table list, the column order inside each `SELECT`, the closed/open
 * interval boundaries (`ts >= start AND ts <= end + 1.0`, `ts > start AND ts <= end + 1.0`,
 * `rowid >= minRow AND rowid <= maxRow`) and the `Lap`/`Lap Time`/sector synthetic tables are
 * the contract: Java STATUS.md pins the acceptance criterion as "30 tables, same row
 * counts/values" against the Python backend, so none of it is paraphrased here.
 *
 * Java -> TypeScript notes - this is the complete list of SQL changes, everything else is the
 * Java statement text character for character:
 * - The only placeholders in the Java source are `updateCarName`'s `?` (a JDBC
 *   `prepareStatement` + `setString`), which becomes `$1` with a `[VARCHAR]` bind type.
 *   Every other value was already concatenated into the SQL text by Java, and stays that way.
 * - `Statement.execute(sql)` -> `session.run(sql)` (one statement per call, like Java).
 * - Java's `connections.open(...)` is a plain read-write JDBC connection. The Node factory
 *   defaults `open()` to `access_mode: 'read_only'`, so the source scan keeps `withConnection`
 *   (read-only, exactly what Java does against a file the game may still be writing) while the
 *   output database uses `withReadWriteConnection` - it is created by this service.
 * - `try (Connection out = ...)` -> `withReadWriteConnection`, whose `finally` disconnects the
 *   connection and closes the instance. Attached databases are detached when the instance
 *   closes; `lap-export-service.test.ts` proves the OS handle is gone by renaming the file
 *   straight after the export, the same trick `infra/duckdb` uses.
 * - `Map<String,String>` metadata keeps SQL NULL values (Java `MetadataReader` puts
 *   `rs.getString(2)` into a `LinkedHashMap`), so `getOrDefault` is reproduced with
 *   `LinkedHashMap` semantics: a present key mapped to NULL yields null, not the default.
 *   That is what makes a NULL `TrackLayout` throw (500) in Java, and what "null" as a
 *   `RecordingTime` does to the file name.
 * - `Double.toString` / `(int)` narrowing / `%02d` padding are emulated by the helpers at the
 *   bottom so the generated SQL text and the file name are byte-identical to Java's.
 * - Java leaves a half-written output file behind when the slice SQL fails; this port removes
 *   it (and the `*.wal` DuckDB keeps next to it) on every failure path, because a stale cache
 *   file both blocks the Windows handle and shows up as a corrupt "export" to the user.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VARCHAR } from '@duckdb/node-api';
import { ApiException } from '../api/error.js';
import type { LapInfo, LapsResponse } from '../domain/types.js';
import type { CarCatalog } from '../infra/car/car-catalog.js';
import { isBlank } from '../infra/track/track-names.js';
import type { DuckDbConnectionFactory } from '../infra/duckdb/connection.js';
import * as DuckDbReads from '../infra/duckdb/reads.js';
import type { AppPaths } from '../infra/fs/app-paths.js';
import { PathSafety } from '../infra/fs/path-safety.js';
import type { SessionResolver, SetupService } from './setup-service.js';
import type { LapService } from './lap-service.js';
import type { Logger } from '../lib/log.js';

/** LapExportService.java:31 - tables copied wholesale, no time slicing. */
const COPY_WHOLE = new Set(['metadata', 'channelsList']);

/** LapExportService.java:32-35 - change-only channels: carry the pre-lap value in, then the events. */
const SPARSE_CHANNELS = new Set([
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

/** LapExportService.java:243-245 - `record ExportResult(Path path, String filename)`. */
export interface ExportResult {
  readonly path: string;
  readonly filename: string;
}

/** LapExportService.java:246-255 - `record SourceInfo`. */
interface SourceInfo {
  readonly tables: string[];
  readonly maxRows: number;
  readonly minRow100: number;
  readonly maxRow100: number;
  readonly columns: Map<string, string[]>;
  readonly rowCounts: Map<string, number>;
  readonly lapDistOffset: number;
}

export class LapExportService {
  constructor(
    private readonly sessions: SessionResolver,
    private readonly lapService: LapService,
    private readonly setupService: SetupService,
    private readonly carCatalog: CarCatalog,
    private readonly connections: DuckDbConnectionFactory,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {}

  async export(
    profileId: string,
    sessionId: string,
    lapNumber: number,
    customCarModel: string | null | undefined,
  ): Promise<ExportResult> {
    const source = await this.sessions.resolve(profileId, sessionId);
    // LapExportService.java:60 calls the single-argument overload, i.e. Java's path-only
    // header cache key; no profile/session identity is folded in.
    const header = await this.lapService.header(source);
    const target = header.laps.find((lap) => lap.lap === lapNumber);
    if (target === undefined) {
      throw new ApiException(404, `Lap ${lapNumber} not found`);
    }

    const metadata = await this.setupService.readMetadata(source);
    const layoutName = requireString(
      getOrDefault(metadata, 'TrackLayout', 'Layout'),
      'TrackLayout',
    )
      .replaceAll(' ', '-')
      .replaceAll(/[\\/*?:"<>|]/g, '');
    const rawCar = getOrDefault(metadata, 'CarName', '');
    const rawClass = getOrDefault(metadata, 'CarClass', '');
    // Java evaluates `customCarModel != null && !customCarModel.isBlank()` twice; the value is
    // never reassigned, so narrowing once here is the same rule.
    const custom = customModel(customCarModel);
    let carModel = custom === null ? this.carCatalog.getCarInfo(rawCar, rawClass).modelName : custom;
    carModel = carModel.replaceAll(' ', '-');
    const recordingTime = getOrDefault(metadata, 'RecordingTime', PathSafety.stripDuckDb(sessionId));
    const lapTime = formatLapTime(target.duration);
    const filename = `${layoutName}-${carModel}-L${lapNumber}-${lapTime}_${recordingTime}.duckdb`;

    const cacheDir = this.paths.profileCacheDir(profileId);
    const output = path.resolve(cacheDir, filename);
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.rm(output, { force: true });
      await this.writeSlicedDatabase(source, header, target, output);
      if (custom !== null) {
        await this.updateCarName(output, custom);
      }
      return { path: output, filename };
    } catch (error) {
      await this.removeOutput(output);
      if (error instanceof ApiException) throw error;
      this.logger.error({ err: error, sessionId, lapNumber }, 'Lap export failed');
      throw new ApiException(500, `Lap export failed: ${messageOf(error)}`, { cause: error });
    }
  }

  /**
   * LapExportService.java:97-184. `header` is unused by the Java method too (it is passed for
   * symmetry with the caller); the slicing only needs `target` plus the source statistics.
   */
  private async writeSlicedDatabase(
    source: string,
    header: LapsResponse,
    target: LapInfo,
    output: string,
  ): Promise<void> {
    const start = target.startTime;
    const end = target.endTime;
    const duration = target.duration;

    const info = await this.inspectSource(source, start, end);
    const tables = info.tables;

    await this.connections.withReadWriteConnection(output, async (session) => {
      await session.run(`ATTACH '${sqlLiteral(path.resolve(source))}' AS src (READ_ONLY)`);
      for (const table of tables) {
        if (COPY_WHOLE.has(table)) {
          await session.run(`CREATE TABLE ${ident(table)} AS SELECT * FROM src.${ident(table)}`);
          continue;
        }
        if (table === 'Lap') {
          await session.run(
            `CREATE TABLE ${ident(table)} AS SELECT * FROM (VALUES (CAST(0.0 AS DOUBLE), 0), ` +
              `(CAST(${javaDouble(duration)} AS DOUBLE), 1)) t(ts, value)`,
          );
          continue;
        }
        if (table === 'Lap Time' || table === 'Best LapTime') {
          await session.run(
            `CREATE TABLE ${ident(table)} AS SELECT CAST(${javaDouble(duration)} AS DOUBLE) AS ts, ` +
              `CAST(${javaDouble(duration)} AS DOUBLE) AS value`,
          );
          continue;
        }
        if ((table === 'Last Sector1' || table === 'Best Sector1') && target.s1 !== null) {
          await session.run(
            `CREATE TABLE ${ident(table)} AS SELECT CAST(${javaDouble(target.s1)} AS DOUBLE) AS ts, ` +
              `CAST(${javaDouble(target.s1)} AS DOUBLE) AS value`,
          );
          continue;
        }
        if (
          (table === 'Last Sector2' || table === 'Best Sector2') &&
          target.s1 !== null &&
          target.s2 !== null
        ) {
          const total = target.s1 + target.s2;
          await session.run(
            `CREATE TABLE ${ident(table)} AS SELECT CAST(${javaDouble(total)} AS DOUBLE) AS ts, ` +
              `CAST(${javaDouble(total)} AS DOUBLE) AS value`,
          );
          continue;
        }

        const columns = info.columns.get(table) ?? [];
        const rowCount = info.rowCounts.get(table) ?? 0;
        const hasTimestamp = columns.includes('ts');
        const valueColumns = columns.filter((column) => column !== 'ts');
        if (valueColumns.length === 0) {
          continue;
        }
        const valueList = valueColumns.map(ident).join(', ');

        if (hasTimestamp) {
          if (SPARSE_CHANNELS.has(table)) {
            // Copied as written, including the quirk: `ORDER BY ts DESC` binds to the SELECT
            // alias (the constant 0.0), so every pre-lap candidate ties and DuckDB may carry in
            // any one of them. Identical SQL in the Java backend, so identical behaviour here -
            // "fixing" it would break the row-for-row parity the export is judged on.
            await session.run(
              `CREATE TABLE ${ident(table)} AS SELECT CAST(0.0 AS DOUBLE) AS ts, ${valueList}` +
                ` FROM src.${ident(table)} WHERE ts <= ${javaDouble(start)}` +
                ' ORDER BY ts DESC LIMIT 1',
            );
            await session.run(
              `INSERT INTO ${ident(table)} SELECT ts - ${javaDouble(start)}, ${valueList}` +
                ` FROM src.${ident(table)} WHERE ts > ${javaDouble(start)} AND ts <= ${javaDouble(end + 1.0)}`,
            );
          } else {
            await session.run(
              `CREATE TABLE ${ident(table)} AS SELECT ts - ${javaDouble(start)} AS ts, ${valueList}` +
                ` FROM src.${ident(table)} WHERE ts >= ${javaDouble(start)} AND ts <= ${javaDouble(end + 1.0)}`,
            );
          }
        } else {
          const ratio = info.maxRows > 0 ? rowCount / info.maxRows : 0.0;
          const minRow = javaInt(info.minRow100 * ratio);
          const maxRow = javaInt(info.maxRow100 * ratio);
          if (table === 'GPS Time') {
            await session.run(
              `CREATE TABLE ${ident(table)} AS SELECT CAST(value - ${javaDouble(start)} AS FLOAT) AS value` +
                ` FROM src.${ident(table)} WHERE rowid >= ${minRow} AND rowid <= ${maxRow}`,
            );
          } else if (table === 'Lap Dist') {
            const offsetValue = info.lapDistOffset;
            await session.run(
              `CREATE TABLE ${ident(table)} AS SELECT CAST(value - ${javaDouble(offsetValue)} AS FLOAT) AS value` +
                ` FROM src.${ident(table)} WHERE rowid >= ${minRow} AND rowid <= ${maxRow}`,
            );
          } else {
            await session.run(
              `CREATE TABLE ${ident(table)} AS SELECT * FROM src.${ident(table)}` +
                ` WHERE rowid >= ${minRow} AND rowid <= ${maxRow}`,
            );
          }
        }
      }
      await session.run(
        `INSERT INTO metadata (key, value) VALUES ('ExportedLap', '${target.lap}')`,
      );
      await session.run(
        `INSERT INTO metadata (key, value) VALUES ('ExportedFrom', '${sqlLiteral(path.basename(source))}')`,
      );
      await session.run('CHECKPOINT');
    });
  }

  /** LapExportService.java:186-217 - source statistics, read over a read-only connection. */
  private async inspectSource(source: string, start: number, end: number): Promise<SourceInfo> {
    return this.connections.withConnection(source, async (session) => {
      const connection = session.connection;
      const tables = await DuckDbReads.tableNames(connection);
      const count = await DuckDbReads.scalarInt(connection, 'SELECT COUNT(*) FROM "GPS Time"');
      const maxRows = count === null ? 0 : count;
      const minRow = await DuckDbReads.scalarInt(
        connection,
        `SELECT MIN(rowid) FROM "GPS Time" WHERE value >= ${javaDouble(start)}`,
      );
      const maxRow = await DuckDbReads.scalarInt(
        connection,
        `SELECT MIN(rowid) FROM "GPS Time" WHERE value > ${javaDouble(end)}`,
      );
      const minRow100 = minRow === null ? 0 : minRow;
      const maxRow100 = maxRow === null ? Math.max(0, maxRows - 1) : maxRow;

      const columns = new Map<string, string[]>();
      const rowCounts = new Map<string, number>();
      for (const table of tables) {
        columns.set(table, await DuckDbReads.columns(connection, table));
        const tableCount = await DuckDbReads.scalarInt(connection, `SELECT COUNT(*) FROM ${ident(table)}`);
        rowCounts.set(table, tableCount === null ? 0 : tableCount);
      }

      let lapDistOffset = 0.0;
      if (rowCounts.has('Lap Dist') && maxRows > 0) {
        const ratioRow = javaInt(minRow100 * ((rowCounts.get('Lap Dist') as number) / maxRows));
        const offset = await DuckDbReads.scalarDouble(
          connection,
          `SELECT value FROM "Lap Dist" WHERE rowid >= ${ratioRow} ORDER BY rowid LIMIT 1`,
        );
        if (offset !== null) {
          lapDistOffset = offset;
        }
      }
      return { tables, maxRows, minRow100, maxRow100, columns, rowCounts, lapDistOffset };
    });
  }

  /** LapExportService.java:219-226 - JDBC `?` + `setString` -> `$1` + a VARCHAR bind value. */
  private async updateCarName(output: string, carName: string): Promise<void> {
    await this.connections.withReadWriteConnection(output, async (session) => {
      await session.run(
        "UPDATE metadata SET value = $1 WHERE key = 'CarName'",
        [carName],
        [VARCHAR],
      );
      await session.run('CHECKPOINT');
    });
  }

  /** Failure-path cleanup (see the header note); runs after the DuckDB session is closed. */
  private async removeOutput(output: string): Promise<void> {
    for (const file of [output, `${output}.wal`]) {
      try {
        await fs.promises.rm(file, { force: true });
      } catch {
        this.logger.warn({ file }, 'Lap export left an unusable file behind');
      }
    }
  }
}

/**
 * LapExportService.java:235-237 - `"name"` with inner quotes doubled. Java writes this by hand
 * rather than binding, and DuckDB accepts it for both identifiers and the ATTACH path.
 */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** LapExportService.java:239-241 - `'` doubled for inlined string literals. */
function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Java `Map.getOrDefault` on a `LinkedHashMap`: a key that exists but holds SQL NULL returns
 * null, NOT the default. The Node `MetadataReader` keeps those NULLs, so the same rule applies.
 */
function getOrDefault(
  metadata: Map<string, string | null>,
  key: string,
  fallback: string,
): string | null {
  return metadata.has(key) ? (metadata.get(key) ?? null) : fallback;
}

/** A NULL `TrackLayout` reaches `String.replace` in Java and throws NPE (HTTP 500) there. */
function requireString(value: string | null, key: string): string {
  if (value === null) {
    throw new TypeError(`Cannot invoke "String.replace(CharSequence, CharSequence)" on the null metadata value "${key}"`);
  }
  return value;
}

/** Java `customCarModel != null && !customCarModel.isBlank()`, narrowed once. */
function customModel(value: string | null | undefined): string | null {
  return value === null || value === undefined || isBlank(value) ? null : value;
}

/** LapExportService.java:228-233 - `"%dm%02ds%03d"` over truncated double arithmetic. */
function formatLapTime(seconds: number): string {
  const minutes = javaInt(seconds / 60);
  const wholeSeconds = javaInt(seconds % 60);
  const millis = javaInt((seconds * 1000) % 1000);
  return `${minutes}m${padDigits(wholeSeconds, 2)}s${padDigits(millis, 3)}`;
}

/** `String.format("%0<N>d", v)` - the sign counts towards the width, digits are zero-padded. */
function padDigits(value: number, width: number): string {
  const text = String(value);
  if (text.length >= width) return text;
  const negative = text.startsWith('-');
  const padding = '0'.repeat(width - text.length);
  return negative ? `-${padding}${text.slice(1)}` : `${padding}${text}`;
}

/** Java's `(int)` narrowing conversion of a double: truncate toward zero, then saturate. */
function javaInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated > 2147483647) return 2147483647;
  if (truncated < -2147483648) return -2147483648;
  return truncated;
}

/**
 * Java's `Double.toString`, so the concatenated SQL text is character-for-character what the
 * Java backend sends: always a decimal point (`100.0`, never `100`), and scientific notation
 * written `1.0E7` / `1.0E-7` outside [1e-3, 1e7) instead of JS's `1e+7` / `1e-7`.
 */
function javaDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';

  const sign = Object.is(value, -0) ? '-' : '';
  const abs = Math.abs(value);
  if (abs === 0) return `${sign}0.0`;

  const raw = String(abs);
  if (abs >= 1e-3 && abs < 1e7 && !raw.includes('e')) {
    return sign + (raw.includes('.') ? raw : `${raw}.0`);
  }

  const exponentIndex = raw.indexOf('e');
  const mantissa = exponentIndex === -1 ? raw : raw.slice(0, exponentIndex);
  const exponentValue = exponentIndex === -1 ? 0 : Number.parseInt(raw.slice(exponentIndex + 1), 10);
  const [integerPart, fractionPart = ''] = mantissa.split('.');
  const stripped = (integerPart + fractionPart).replace(/^0+/, '');
  const digits = stripped.replace(/0+$/, '');
  if (digits === '') return `${sign}0.0`;

  // value === 0.<digits> * 10^power, so the printed exponent is power - 1.
  const power = digits.length + exponentValue - fractionPart.length + (stripped.length - digits.length);
  const mantissaText = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits}.0`;
  return `${sign}${mantissaText}E${power - 1}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
