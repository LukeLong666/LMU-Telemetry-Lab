import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pino from 'pino';
import { loadEnv } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';
import { ProfileService } from '../../src/application/profile-service.js';
import type { AvatarUpload } from '../../src/application/profile-service.js';
import { AppPaths } from '../../src/infra/fs/app-paths.js';
import { ProfileRepository } from '../../src/infra/fs/profile-repository.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import type { DiscordSessionGateway } from '../../src/infra/fs/session-repository.js';
import { isDirectory, isRegularFile } from '../../src/infra/fs/atomic-files.js';

const logger = pino({ level: 'silent' });
/** Java: ProfileService.MAX_AVATAR_BYTES. */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

let root = '';
const homes: string[] = [];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-app-'));
});

afterEach(async () => {
  const pending = homes.splice(0, homes.length);
  await Promise.all(pending.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function envFor(home: string): Env {
  return {
    ...loadEnv(),
    appHome: home,
    dataDir: path.join(home, 'data'),
    telemetryDir: '',
    frontendDir: path.join(home, 'frontend', 'dist'),
    steeringWheelDir: path.join(home, 'steering wheel'),
    logFile: path.join(home, 'backend_debug.log'),
  };
}

interface Fixture {
  service: ProfileService;
  repository: ProfileRepository;
  paths: AppPaths;
  home: string;
}

async function fixture(name: string): Promise<Fixture> {
  const home = path.join(root, name);
  await fs.mkdir(home, { recursive: true });
  homes.push(home);
  const paths = new AppPaths(envFor(home), logger);
  const repository = new ProfileRepository(paths, logger);
  return { service: new ProfileService(repository, paths, logger), repository, paths, home };
}

function streamOf(...chunks: (string | Buffer)[]): Readable {
  return Readable.from(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
}

function avatar(content: string | Buffer, filename: string | null | undefined): AvatarUpload {
  return { filename, stream: streamOf(content), contentType: 'image/png' };
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

const unusedDiscord: DiscordSessionGateway = {
  async getThreadAttachments() {
    return null;
  },
  async downloadFile() {
    throw new Error('Discord must not be touched by the profile chain');
  },
};

describe('ProfileService', () => {
  it('init() bootstraps Guest and migrates legacy DuckDB_data, staying idempotent', async () => {
    const { service, paths, repository } = await fixture('init');
    const legacy = paths.legacyDataDir();
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'old.duckdb'), 'old');
    await fs.writeFile(path.join(legacy, 'notes.txt'), 'ignored');

    await service.init();
    await service.init();

    const profiles = await service.list();
    expect(profiles.map((profile) => profile.id)).toEqual(['guest']);
    expect(profiles[0].is_default).toBe(true);
    expect(profiles[0].session_count).toBe(1);
    expect(await listNames(paths.profileDataDir('guest'))).toEqual(['old.duckdb']);
    expect(await repository.find('guest')).toBeDefined();
  });

  it('list() self-heals an empty store and counts session files per profile', async () => {
    const { service, paths } = await fixture('list');

    const first = await service.list();
    expect(first.map((profile) => profile.id)).toEqual(['guest']);
    expect(first[0].session_count).toBe(0);

    const data = paths.profileDataDir('guest');
    await fs.writeFile(path.join(data, 'a.duckdb'), 'a');
    await fs.writeFile(path.join(data, 'b.DUCKDB'), 'b');
    await fs.writeFile(path.join(data, 'notes.txt'), 'c');

    const [guest] = await service.list();
    expect(guest.session_count).toBe(2);
  });

  it('reports the same sessions SessionRepository lists', async () => {
    const { service, paths } = await fixture('session-count');
    await service.init();

    const source = path.join(paths.appHome, 'incoming');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'race one.duckdb'), 'race');

    const sessions = new SessionRepository(paths, unusedDiscord, logger);
    expect(await sessions.importPaths('guest', [path.join(source, 'race one.duckdb')])).toEqual([
      'race one.duckdb',
    ]);

    expect((await service.list())[0].session_count).toBe(1);
    expect(await sessions.listFiles('guest')).toEqual([
      path.join(paths.profileDataDir('guest'), 'race one.duckdb'),
    ]);
  });

  it('creates, renames, reorders and deletes through the repository', async () => {
    const { service, repository, paths } = await fixture('crud');
    await service.init();

    const created = await service.create('Driver One');
    expect(created.id).toBe('driver_one');
    expect(created.is_default).toBe(false);
    expect(created.session_count).toBe(0);

    await service.create('Alice');
    await service.update('driver_one', '  Renamed  ');
    expect((await repository.find('driver_one'))?.name).toBe('Renamed');
    await expect(service.update('nobody', 'X')).rejects.toMatchObject({
      status: 404,
      message: 'Profile not found',
    });

    const reordered = await service.reorder(['alice', 'driver_one']);
    expect(reordered.map((profile) => profile.id)).toEqual(['alice', 'driver_one', 'guest']);
    expect(reordered.map((profile) => profile.is_default)).toEqual([true, false, false]);

    await service.delete('driver_one');
    expect(await repository.find('driver_one')).toBeUndefined();
    expect(isDirectory(paths.profileRoot('driver_one'))).toBe(false);

    await service.delete('guest');
    expect(await repository.find('guest')).toBeDefined();

    await expect(service.create('   ')).rejects.toMatchObject({
      status: 400,
      message: 'Profile name is required',
    });
  });

  it('stores an avatar under the profile avatars dir and returns its url', async () => {
    const { service, repository, paths } = await fixture('avatar');
    await service.init();

    const url = await service.uploadAvatar('guest', avatar('png-bytes', 'me.png'));
    expect(url).toMatch(/^\/api\/v1\/profile-data\/Data\/guest\/avatars\/avatar_\d{10}\.png$/);

    const filename = url.split('/').pop() as string;
    const target = path.join(paths.profileAvatarDir('guest'), filename);
    expect(isRegularFile(target)).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('png-bytes');
    expect((await repository.find('guest'))?.avatar_url).toBe(url);

    const stored = JSON.parse(await fs.readFile(paths.profilesFile(), 'utf8')) as Record<string, unknown>[];
    expect(stored[0].avatar_url).toBe(url);
  });

  it('sanitises the uploaded name and keeps only whitelisted extensions', async () => {
    const { service, paths } = await fixture('avatar-name');
    await service.init();

    const url = await service.uploadAvatar('guest', avatar('x', '../../evil/Passwd upper.PNG'));
    expect(url.split('/').pop()).toMatch(/^avatar_\d{10}\.png$/);
    expect(await listNames(paths.profileAvatarDir('guest'))).toEqual([url.split('/').pop() as string]);

    for (const [filename, expected] of [
      ['notes.txt', 'Unsupported avatar file type'],
      ['noextension', 'Unsupported avatar file type'],
      [null, 'Unsupported avatar file type'],
      ['   ', 'File name is required'],
    ] as const) {
      await expect(service.uploadAvatar('guest', avatar('x', filename))).rejects.toMatchObject({
        status: 400,
        message: expected,
      });
    }
    expect(await listNames(paths.profileAvatarDir('guest'))).toHaveLength(1);
  });

  it('rejects a missing profile, an empty body and an oversized upload', async () => {
    const { service, paths } = await fixture('avatar-errors');
    await service.init();

    const missing = avatar('x', 'a.png');
    await expect(service.uploadAvatar('nobody', missing)).rejects.toMatchObject({
      status: 404,
      message: 'Profile not found',
    });
    expect(missing.stream.destroyed).toBe(true);

    await expect(service.uploadAvatar('guest', undefined)).rejects.toMatchObject({
      status: 400,
      message: 'Avatar file is required',
    });
    await expect(service.uploadAvatar('guest', avatar('', 'a.png'))).rejects.toMatchObject({
      status: 400,
      message: 'Avatar file is required',
    });
    await expect(
      service.uploadAvatar('guest', { filename: 'a.png', stream: streamOf('x'), size: 0 }),
    ).rejects.toMatchObject({ status: 400, message: 'Avatar file is required' });

    await expect(
      service.uploadAvatar('guest', { filename: 'a.png', stream: streamOf('x'), size: MAX_AVATAR_BYTES + 1 }),
    ).rejects.toMatchObject({ status: 413, message: 'Avatar file too large' });

    await expect(
      service.uploadAvatar('guest', {
        filename: 'a.png',
        stream: streamOf(Buffer.alloc(MAX_AVATAR_BYTES + 1, 7)),
      }),
    ).rejects.toMatchObject({ status: 413, message: 'Avatar file too large' });

    expect(await listNames(paths.profileAvatarDir('guest'))).toEqual([]);
  });
});
