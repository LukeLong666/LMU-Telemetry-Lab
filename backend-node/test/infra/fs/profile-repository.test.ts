import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ApiException } from '../../../src/api/error.js';
import { AppPaths } from '../../../src/infra/fs/app-paths.js';
import { ProfileRepository } from '../../../src/infra/fs/profile-repository.js';
import { isDirectory } from '../../../src/infra/fs/atomic-files.js';
import type { Env } from '../../../src/config/env.js';

const logger = pino({ level: 'silent' });

function testEnv(root: string): Env {
  return {
    port: 0,
    address: '127.0.0.1',
    devMode: true,
    dataDir: path.join(root, 'data'),
    telemetryDir: '',
    frontendDir: path.join(root, 'frontend', 'dist'),
    steeringWheelDir: path.join(root, 'frontend', 'public', 'steering wheel'),
    version: 'test',
    logFile: path.join(root, 'backend_debug.log'),
    appHome: root,
  };
}

async function withRepository(
  run: (repository: ProfileRepository, paths: AppPaths) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-test-'));
  try {
    const paths = new AppPaths(testEnv(root), logger);
    await run(new ProfileRepository(paths, logger), paths);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function duckDbNames(dir: string): Promise<string[]> {
  return fs
    .readdir(dir)
    .then((names) => names.filter((name) => name.toLowerCase().endsWith('.duckdb')).sort());
}

describe('ProfileRepository', () => {
  it('bootstraps the Guest profile once and persists it without transient fields', async () => {
    await withRepository(async (repository, paths) => {
      const guest = await repository.ensureGuest();
      expect(guest.id).toBe('guest');
      expect(guest.is_default).toBe(true);
      expect(guest.session_count).toBe(0);
      expect(guest.avatar_url).toBeUndefined();

      const stored = JSON.parse(await fs.readFile(paths.profilesFile(), 'utf8')) as Record<string, unknown>[];
      expect(stored).toHaveLength(1);
      expect(stored[0].session_count).toBeUndefined();
      expect(stored[0].avatar_url).toBeUndefined();
      expect(typeof stored[0].created_at).toBe('string');
      expect(String(stored[0].created_at)).not.toMatch(/[zZ+]/);

      const again = await repository.ensureGuest();
      expect(again.id).toBe('guest');
      expect(await repository.list()).toHaveLength(1);
    });
  });

  it('slugifies names, keeps ids unique and reuses a profile with the same name', async () => {
    await withRepository(async (repository) => {
      const created = await repository.create('Driver One', false, null);
      expect(created.id).toBe('driver_one');
      expect(created.session_count).toBe(0);

      const duplicate = await repository.create('  driver one  ', false, null);
      expect(duplicate.id).toBe('driver_one');

      const collision = await repository.create('Driver_One', false, null);
      expect(collision.id).toBe('driver_one_2');

      const sanitized = await repository.create('Bad/Name*', false, null);
      expect(sanitized.id).toBe('bad_name_');

      await expect(repository.create('   ', false, null)).rejects.toMatchObject({
        status: 400,
        message: 'Profile name is required',
      });
    });
  });

  it('counts sessions per profile from the .duckdb files on disk', async () => {
    await withRepository(async (repository, paths) => {
      await repository.ensureGuest();
      paths.ensureProfileDirs('guest');
      const data = paths.profileDataDir('guest');
      await fs.writeFile(path.join(data, 'a.duckdb'), 'a');
      await fs.writeFile(path.join(data, 'b.DUCKDB'), 'b');
      await fs.writeFile(path.join(data, 'notes.txt'), 'c');
      await fs.mkdir(path.join(data, 'nested.duckdb'));

      const [guest] = await repository.list();
      expect(guest.id).toBe('guest');
      expect(guest.session_count).toBe(2);
    });
  });

  it('migrates legacy DuckDB_data into the Guest profile exactly once', async () => {
    await withRepository(async (repository, paths) => {
      const legacy = paths.legacyDataDir();
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, 'old.duckdb'), 'old');
      await fs.writeFile(path.join(legacy, 'notes.txt'), 'ignored');

      await repository.ensureGuest();
      await repository.migrateLegacyData();
      expect(await duckDbNames(paths.profileDataDir('guest'))).toEqual(['old.duckdb']);

      // Already migrated: a later legacy file must not be picked up again.
      await fs.writeFile(path.join(legacy, 'newer.duckdb'), 'newer');
      await repository.migrateLegacyData();
      expect(await duckDbNames(paths.profileDataDir('guest'))).toEqual(['old.duckdb']);

      const [guest] = await repository.list();
      expect(guest.session_count).toBe(1);
    });
  });

  it('reorders profiles, marks the first as default and skips unknown ids', async () => {
    await withRepository(async (repository) => {
      await repository.ensureGuest();
      await repository.create('Alice', false, null);
      await repository.create('Bob', false, null);

      const reordered = await repository.reorder(['bob', 'alice']);
      expect(reordered.map((profile) => profile.id)).toEqual(['bob', 'alice', 'guest']);
      expect(reordered.map((profile) => profile.is_default)).toEqual([true, false, false]);

      const partial = await repository.reorder(['unknown', null as unknown as string, 'alice']);
      expect(partial.map((profile) => profile.id)).toEqual(['alice', 'bob', 'guest']);
      expect(partial[0].is_default).toBe(true);
    });
  });

  it('renames avatars only for known profiles and never deletes Guest', async () => {
    await withRepository(async (repository, paths) => {
      await repository.ensureGuest();
      await repository.create('Alice', false, null);

      expect(await repository.updateName('alice', '  Alice II  ')).toBe(true);
      expect(await repository.updateName('missing', 'Nobody')).toBe(false);
      expect((await repository.find('alice'))?.name).toBe('Alice II');
      await expect(repository.updateName('alice', '  ')).rejects.toThrow(ApiException);

      expect(await repository.updateAvatar('alice', '/api/v1/profile-data/x.png')).toBe(true);
      expect((await repository.find('alice'))?.avatar_url).toBe('/api/v1/profile-data/x.png');
      expect(await repository.updateAvatar('missing', '/x.png')).toBe(false);

      await repository.delete('guest');
      expect(await repository.find('guest')).toBeDefined();

      await repository.delete('alice');
      expect(await repository.find('alice')).toBeUndefined();
      expect(isDirectory(paths.profileRoot('alice'))).toBe(false);
    });
  });
});
