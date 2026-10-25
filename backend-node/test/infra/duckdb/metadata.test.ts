import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/lib/log.js';
import { DuckDbConnectionFactory } from '../../../src/infra/duckdb/connection.js';
import { MetadataReader } from '../../../src/infra/duckdb/metadata.js';
import { createSessionFixture, makeTempDir, runStatements, type TestDatabase } from './fixture.js';

interface RecordingLogger extends Logger {
  warnings: { message: string; err: unknown }[];
}

function recordingLogger(): RecordingLogger {
  const warnings: { message: string; err: unknown }[] = [];
  const logger = {
    warn: (obj: unknown, message?: string) => {
      warnings.push({ message: message ?? '', err: (obj as { err?: unknown })?.err });
    },
    warnings,
  };
  return logger as unknown as RecordingLogger;
}

const factory = new DuckDbConnectionFactory();
let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await createSessionFixture();
}, 60_000);

afterAll(() => {
  fixture?.dispose();
});

describe('MetadataReader', () => {
  it('reads the metadata table in row order, keeping NULL as null', async () => {
    const reader = new MetadataReader(recordingLogger());
    const metadata = await factory.withConnection(fixture.database, (session) => reader.read(session.connection));

    expect([...metadata.keys()]).toEqual(['TrackName', 'CarName', 'SessionTime', 'CarClass']);
    expect(metadata.get('TrackName')).toBe('Spa-Francorchamps');
    expect(metadata.get('CarName')).toBeNull();
    expect(metadata.get('SessionTime')).toBe('   ');
  });

  it('falls back for missing, null and blank keys', async () => {
    const reader = new MetadataReader(recordingLogger());
    const metadata = await factory.withConnection(fixture.database, (session) => reader.read(session.connection));

    expect(reader.value(metadata, 'TrackName', 'Unknown Track')).toBe('Spa-Francorchamps');
    expect(reader.value(metadata, 'CarClass', 'Unknown Class')).toBe('GTP');
    expect(reader.value(metadata, 'CarName', 'Unknown Car')).toBe('Unknown Car');
    expect(reader.value(metadata, 'SessionTime', 'Unknown Time')).toBe('Unknown Time');
    expect(reader.value(metadata, 'NoSuchKey', 'fallback')).toBe('fallback');
  });

  it('returns an empty map and warns when the table is missing', async () => {
    const dir = makeTempDir('lmutl-duckdb-nometa-');
    try {
      const database = path.join(dir, 'bare.duckdb');
      await runStatements(database, ['CREATE TABLE "GPS Time" (value DOUBLE)']);

      const logger = recordingLogger();
      const reader = new MetadataReader(logger);
      const metadata = await factory.withConnection(database, (session) => reader.read(session.connection));

      expect(metadata.size).toBe(0);
      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0].message).toBe('Failed to read metadata table');
      expect(String(logger.warnings[0].err)).toContain('metadata');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
