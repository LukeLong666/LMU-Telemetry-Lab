import type { DuckDBConnection } from '@duckdb/node-api';
import type { Logger } from '../../lib/log.js';
import { readRows, toText } from './reads.js';

/**
 * Java `MetadataReader`: the `metadata` table of a session database, read as an
 * insertion-ordered key/value map (Java's LinkedHashMap). Consumers are
 * `SetupService.readMetadata` (SVM export file name), `DiscordService` and
 * `LapExportService`; none of them reorder the rows.
 */
export class MetadataReader {
  constructor(private readonly logger: Logger) {}

  /**
   * `SELECT key, value FROM metadata`. A missing or broken table is logged and
   * returns an empty map, exactly like the Java version - metadata is optional,
   * a session still analyses without it.
   *
   * SQL NULL values stay `null` (JDBC `getString` returned null); rows with a NULL
   * key are skipped, since no `get(key)` could ever return them.
   */
  async read(connection: DuckDBConnection): Promise<Map<string, string | null>> {
    const metadata = new Map<string, string | null>();
    const sql = 'SELECT key, value FROM metadata';
    try {
      const rows = await readRows(connection, sql);
      for (const row of rows) {
        const key = toText(row[0]);
        if (key === null) continue;
        metadata.set(key, toText(row[1]));
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to read metadata table');
    }
    return metadata;
  }

  /** Java `value(metadata, key, fallback)`: null, undefined and blank all fall back. */
  value(metadata: Map<string, string | null>, key: string, fallback: string): string {
    const value = metadata.get(key);
    return value === null || value === undefined || value.trim() === '' ? fallback : value;
  }
}
