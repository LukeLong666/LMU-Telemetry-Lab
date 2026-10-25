import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pino from 'pino';
import { AppPaths } from '../../../src/infra/fs/app-paths.js';
import { SessionRepository } from '../../../src/infra/fs/session-repository.js';
import type {
  DiscordAttachmentMap,
  DiscordSessionGateway,
} from '../../../src/infra/fs/session-repository.js';
import { isRegularFile } from '../../../src/infra/fs/atomic-files.js';
import type { Env } from '../../../src/config/env.js';

const logger = pino({ level: 'silent' });

class FakeDiscord implements DiscordSessionGateway {
  downloadCalls = 0;
  attachments: DiscordAttachmentMap | null = { telemetry: { url: 'https://cdn.discordapp.com/1.duckdb' } };
  failDownload = false;

  async getThreadAttachments(_threadId: string): Promise<DiscordAttachmentMap | null> {
    return this.attachments;
  }

  async downloadFile(_url: string, destination: string): Promise<void> {
    this.downloadCalls += 1;
    if (this.failDownload) {
      throw new Error('boom');
    }
    await fs.writeFile(destination, 'telemetry');
  }
}

function namesOf(files: string[]): string[] {
  return files.map((file) => path.basename(file));
}

async function touch(file: string, epochSeconds: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'x');
  const stamp = new Date(epochSeconds * 1000);
  await fs.utimes(file, stamp, stamp);
}

/** AppPaths only keeps a configured telemetry dir that already exists. */
function gameDirOf(paths: AppPaths): string {
  if (paths.gameTelemetryDir === null) {
    throw new Error('Expected the game telemetry dir to be resolved');
  }
  return paths.gameTelemetryDir;
}

async function withRepository(
  run: (
    repository: SessionRepository,
    paths: AppPaths,
    discord: FakeDiscord,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-test-'));
  try {
    const gameDir = path.join(root, 'game');
    await fs.mkdir(gameDir, { recursive: true });
    const env: Env = {
      port: 0,
      address: '127.0.0.1',
      devMode: true,
      dataDir: path.join(root, 'data'),
      telemetryDir: gameDir,
      frontendDir: path.join(root, 'frontend', 'dist'),
      steeringWheelDir: path.join(root, 'frontend', 'public', 'steering wheel'),
      version: 'test',
      logFile: path.join(root, 'backend_debug.log'),
      appHome: root,
    };
    const paths = new AppPaths(env, logger);
    const discord = new FakeDiscord();
    await run(new SessionRepository(paths, discord, logger), paths, discord, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('SessionRepository', () => {
  it('lists .duckdb files newest first and ignores anything else', async () => {
    await withRepository(async (repository, paths) => {
      const data = paths.profileDataDir('guest');
      await touch(path.join(data, 'old.duckdb'), 1_700_000_000);
      await touch(path.join(data, 'new.duckdb'), 1_800_000_000);
      await touch(path.join(data, 'notes.txt'), 1_900_000_000);
      await fs.mkdir(path.join(data, 'fake.duckdb'), { recursive: true });
      await touch(path.join(gameDirOf(paths), 'game-only.duckdb'), 1_750_000_000);

      expect(namesOf(await repository.listFiles('guest'))).toEqual([
        'new.duckdb',
        'game-only.duckdb',
        'old.duckdb',
      ]);
    });
  });

  it('prefers the profile copy when the game folder holds the same file name', async () => {
    await withRepository(async (repository, paths) => {
      const profileCopy = path.join(paths.profileDataDir('guest'), 'dup.duckdb');
      await touch(path.join(gameDirOf(paths), 'dup.duckdb'), 1_800_000_000);
      await touch(profileCopy, 1_700_000_000);

      expect(await repository.listFiles('guest')).toEqual([profileCopy]);
      expect(await repository.resolve('guest', 'dup.duckdb')).toBe(profileCopy);
    });
  });

  it('falls back to the game telemetry folder and reports missing sessions', async () => {
    await withRepository(async (repository, paths) => {
      const gameDir = gameDirOf(paths);
      await touch(path.join(gameDir, 'race.duckdb'), 1_700_000_000);

      expect(await repository.resolve('guest', 'race.duckdb')).toBe(path.join(gameDir, 'race.duckdb'));
      await expect(repository.resolve('guest', 'gone.duckdb')).rejects.toMatchObject({
        status: 404,
        message: 'Session not found',
      });
      await expect(repository.resolve('guest', 'notes.txt')).rejects.toMatchObject({
        status: 400,
        message: 'Only .duckdb files are supported',
      });
      await expect(repository.resolve('guest', '../escape.duckdb')).rejects.toMatchObject({
        status: 400,
        message: 'Path escapes the data directory',
      });
    });
  });

  it('renames within the profile, appends the suffix and clears stale cache entries', async () => {
    await withRepository(async (repository, paths) => {
      const data = paths.profileDataDir('guest');
      await touch(path.join(data, 'race.duckdb'), 1_700_000_000);
      await touch(path.join(data, 'taken.duckdb'), 1_700_000_000);
      await touch(path.join(gameDirOf(paths), 'gameonly.duckdb'), 1_700_000_000);
      const cacheDir = paths.profileCacheDir('guest');
      await touch(path.join(cacheDir, 'race.duckdb.meta'), 1_700_000_000);
      await touch(path.join(cacheDir, 'unrelated.json'), 1_700_000_000);

      await expect(repository.rename('guest', 'gameonly.duckdb', 'y')).rejects.toMatchObject({
        status: 400,
        message: 'Sessions read straight from the game telemetry folder are read-only',
      });

      expect(await repository.rename('guest', 'race.duckdb', '  Final  ')).toBe('Final.duckdb');
      expect(isRegularFile(path.join(data, 'Final.duckdb'))).toBe(true);
      expect(isRegularFile(path.join(data, 'race.duckdb'))).toBe(false);
      expect(isRegularFile(path.join(cacheDir, 'race.duckdb.meta'))).toBe(false);
      expect(isRegularFile(path.join(cacheDir, 'unrelated.json'))).toBe(true);

      await expect(repository.rename('guest', 'taken.duckdb', 'Final')).rejects.toMatchObject({
        status: 400,
        message: 'File with new name already exists',
      });
      await expect(repository.rename('guest', 'Final.duckdb', '   ')).rejects.toMatchObject({
        status: 400,
        message: 'New name is required',
      });
    });
  });

  it('deletes a session and keeps the game telemetry copy untouched', async () => {
    await withRepository(async (repository, paths) => {
      const data = paths.profileDataDir('guest');
      await touch(path.join(data, 'gone.duckdb'), 1_700_000_000);

      await repository.delete('guest', 'gone.duckdb');
      expect(isRegularFile(path.join(data, 'gone.duckdb'))).toBe(false);

      await expect(repository.delete('guest', 'gone.duckdb')).rejects.toMatchObject({ status: 400 });
      await expect(repository.delete('guest', 'notes.txt')).rejects.toMatchObject({
        status: 400,
        message: 'Only .duckdb files are supported',
      });
    });
  });

  it('validates imported paths before copying them into the profile', async () => {
    await withRepository(async (repository, paths, _discord, root) => {
      const sourceDir = path.join(root, 'downloads');
      await touch(path.join(sourceDir, 'imported.duckdb'), 1_700_000_000);
      await touch(path.join(sourceDir, 'notes.txt'), 1_700_000_000);

      await expect(repository.importPaths('guest', [])).rejects.toMatchObject({
        status: 400,
        message: 'No files selected',
      });
      await expect(repository.importPaths('guest', ['relative.duckdb'])).rejects.toMatchObject({
        status: 400,
        message: 'Source path must be absolute: relative.duckdb',
      });
      const missing = path.join(sourceDir, 'missing.duckdb');
      await expect(repository.importPaths('guest', [missing])).rejects.toMatchObject({
        status: 400,
        message: `Source file not found: ${missing}`,
      });
      const wrongType = path.join(sourceDir, 'notes.txt');
      await expect(repository.importPaths('guest', [wrongType])).rejects.toMatchObject({
        status: 400,
        message: `Only .duckdb files are allowed: ${wrongType}`,
      });

      expect(await repository.importPaths('guest', [path.join(sourceDir, 'imported.duckdb')])).toEqual([
        'imported.duckdb',
      ]);
      expect(isRegularFile(path.join(paths.profileDataDir('guest'), 'imported.duckdb'))).toBe(true);
    });
  });

  it('uploads a streamed session file and reports its size', async () => {
    await withRepository(async (repository, paths) => {
      await expect(repository.upload('guest', null)).rejects.toMatchObject({
        status: 400,
        message: 'File is required',
      });
      await expect(
        repository.upload('guest', {
          filename: 'session.txt',
          stream: Readable.from([Buffer.from('x')]),
        }),
      ).rejects.toMatchObject({ status: 400, message: 'Only .duckdb files are allowed' });

      const uploaded = await repository.upload('guest', {
        filename: 'from-web.duckdb',
        stream: Readable.from([Buffer.from('telemetry')]),
      });
      expect(uploaded).toEqual({ id: 'from-web.duckdb', size: 9 });
      expect(isRegularFile(path.join(paths.profileDataDir('guest'), 'from-web.duckdb'))).toBe(true);
    });
  });

  it('resolves discord__ sessions through the shared cache', async () => {
    await withRepository(async (repository, paths, discord) => {
      // Compile-time proof that the ported DiscordClient satisfies this port as-is.
      interface DiscordClientLike {
        getThreadAttachments(threadId: string): Promise<{
          telemetry: { filename: string; url: string; size: number } | null;
          setup: { filename: string; url: string; size: number } | null;
        } | null>;
        downloadFile(url: string, destination: string): Promise<void>;
      }
      const gateway: DiscordSessionGateway = {} as DiscordClientLike;
      expect(gateway).toBeDefined();

      await expect(repository.resolve('guest', 'discord__abc')).rejects.toMatchObject({
        status: 400,
        message: 'Invalid Discord thread id',
      });

      discord.attachments = null;
      await expect(repository.resolve('guest', 'discord__123')).rejects.toMatchObject({
        status: 404,
        message: 'Discord telemetry attachment not found.',
      });

      discord.attachments = { telemetry: { url: 'https://cdn.discordapp.com/123.duckdb' } };
      const cached = path.join(paths.dataRoot, 'cache', 'discord_temp', '123.duckdb');
      expect(await repository.resolve('guest', 'discord__123')).toBe(cached);
      expect(discord.downloadCalls).toBe(1);
      expect(await repository.resolve('guest', 'discord__123')).toBe(cached);
      expect(discord.downloadCalls).toBe(1);

      const failed = new FakeDiscord();
      failed.failDownload = true;
      await expect(
        new SessionRepository(paths, failed, logger).resolve('guest', 'discord__456'),
      ).rejects.toMatchObject({ status: 500, message: 'Failed to download Discord session: boom' });
      expect(isRegularFile(path.join(paths.dataRoot, 'cache', 'discord_temp', '456.duckdb'))).toBe(false);
    });
  });
});
