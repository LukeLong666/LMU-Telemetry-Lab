import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadEnv } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';
import type { OpenPathRequest } from '../../src/api/dto.js';
import { SystemService, openPathCommand } from '../../src/application/system-service.js';
import type { SpawnFileManager } from '../../src/application/system-service.js';
import { AppPaths } from '../../src/infra/fs/app-paths.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import type { DiscordSessionGateway } from '../../src/infra/fs/session-repository.js';
import { FilePicker } from '../../src/infra/system/file-picker.js';
import type { NativeFileDialog } from '../../src/infra/system/file-picker.js';
import { SteeringWheelScanner } from '../../src/infra/system/steering-wheel-scanner.js';

const logger = pino({ level: 'silent' });

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-app-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface FixtureOptions {
  dialog?: NativeFileDialog | null;
  spawn?: SpawnFileManager;
  wheelDir?: string;
  platform?: string;
}

interface Fixture {
  service: SystemService;
  paths: AppPaths;
  home: string;
  calls: [string, string[]][];
  discord: { getThreadAttachments: number; downloadFile: number };
}

async function fixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
  const home = path.join(root, name);
  await fs.mkdir(home, { recursive: true });
  const env: Env = {
    ...loadEnv(),
    appHome: home,
    dataDir: path.join(home, 'data'),
    telemetryDir: '',
    frontendDir: path.join(home, 'frontend', 'dist'),
    steeringWheelDir: options.wheelDir ?? path.join(home, 'steering wheel'),
    logFile: path.join(home, 'backend_debug.log'),
  };
  const realPaths = new AppPaths(env, logger);
  const paths =
    options.platform === undefined
      ? realPaths
      : ({
          ...realPaths,
          platform: () => options.platform as string,
        } as unknown as AppPaths);

  const calls: [string, string[]][] = [];
  const discord = { getThreadAttachments: 0, downloadFile: 0 };
  const gateway: DiscordSessionGateway = {
    async getThreadAttachments() {
      discord.getThreadAttachments += 1;
      return null;
    },
    async downloadFile() {
      discord.downloadFile += 1;
    },
  };

  const service = new SystemService(
    new SessionRepository(realPaths, gateway, logger),
    new FilePicker(options.dialog === undefined ? null : options.dialog, logger),
    new SteeringWheelScanner(realPaths),
    paths,
    logger,
    {
      spawn:
        options.spawn ??
        ((command, args) => {
          calls.push([command, args]);
        }),
    },
  );
  return { service, paths: realPaths, home, calls, discord };
}

async function writeFile(target: string, content = 'x'): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

describe('SystemService.openPathCommand', () => {
  it('picks the platform binary and keeps the path as a single argv entry', () => {
    const target = 'C:\\Users\\Ana María\\Telemetry data\\race 1.duckdb';
    expect(openPathCommand('win32', target)).toEqual(['explorer.exe', [target]]);
    expect(openPathCommand('darwin', target)).toEqual(['open', [target]]);
    expect(openPathCommand('linux', target)).toEqual(['xdg-open', [target]]);
    expect(openPathCommand('freebsd', target)).toEqual(['xdg-open', [target]]);
    // Java matched on os.name with contains("win")/contains("mac").
    expect(openPathCommand('Windows_NT', target)).toEqual(['explorer.exe', [target]]);
    expect(openPathCommand('Mac OS X', target)).toEqual(['open', [target]]);
    const [command, args] = openPathCommand('win32', target);
    expect(command).not.toContain(' ');
    // The path is one argv element, never interpolated into a shell command line.
    expect(args).toEqual([target]);
    expect(args).toHaveLength(1);
  });
});

describe('SystemService.open-path', () => {
  it('launches explorer.exe with the exact normalised path, never through a shell', async () => {
    const { service, calls } = await fixture('open-win', { platform: 'win32' });
    const target = await writeFile(path.join(root, 'open-win', 'Telemetry 数据', 'race one.duckdb'));

    const response = await service.openPath(target);
    expect(response).toEqual({ status: 'success', message: `Opening ${target}` });
    expect(calls).toEqual([['explorer.exe', [target]]]);
    expect(calls[0]?.[1]).toHaveLength(1);
  });

  it('dispatches darwin to open and linux to xdg-open', async () => {
    const mac = await fixture('open-mac', { platform: 'darwin' });
    const dir = path.join(mac.home, 'some dir');
    await fs.mkdir(dir, { recursive: true });
    expect(await mac.service.openPath(dir)).toEqual({ status: 'success', message: `Opening ${dir}` });
    expect(mac.calls).toEqual([['open', [dir]]]);

    const linux = await fixture('open-linux', { platform: 'linux' });
    expect(await linux.service.openPath(linux.home)).toMatchObject({ status: 'success' });
    expect(linux.calls).toEqual([['xdg-open', [linux.home]]]);
  });

  it('falls back to the parent folder when the path itself is gone', async () => {
    const { service, calls, home } = await fixture('open-parent', { platform: 'linux' });
    const missing = path.join(home, 'race 1.duckdb');

    const response = await service.openPath(missing);
    expect(response).toEqual({
      status: 'partial',
      message: `Path not found, opening parent: ${home}`,
    });
    expect(calls).toEqual([['xdg-open', [home]]]);
  });

  it('404s when neither the path nor its parent exists and 400s on a blank path', async () => {
    const { service } = await fixture('open-missing');
    await expect(service.openPath(path.join(root, 'definitely-missing', 'a.duckdb'))).rejects.toMatchObject({
      status: 404,
      message: 'Path not found',
    });
    await expect(service.openPath('   ')).rejects.toMatchObject({ status: 400, message: 'Path is required' });
    await expect(service.openPath(null)).rejects.toMatchObject({ status: 400, message: 'Path is required' });
    await expect(service.openPath(undefined)).rejects.toMatchObject({ status: 400, message: 'Path is required' });
  });

  it('maps a failing launch to the Java 500 wording', async () => {
    const { service, home } = await fixture('open-boom', {
      spawn: () => {
        throw new Error('boom');
      },
    });
    await expect(service.openPath(home)).rejects.toMatchObject({
      status: 500,
      message: 'Failed to open path: boom',
    });
  });
});

describe('SystemService.validate-path', () => {
  it('reports existence only, exactly like Java', async () => {
    const { service, home } = await fixture('validate');
    const duckdb = await writeFile(path.join(home, 'data', 'guest-ish', '遥测 race.duckdb'));
    const other = await writeFile(path.join(home, 'notes.txt'));

    expect(await service.validatePath(duckdb)).toEqual({ exists: true });
    // A non-.duckdb file is still just "existing" for this endpoint; the filtering lives in import.
    expect(await service.validatePath(other)).toEqual({ exists: true });
    expect(await service.validatePath(home)).toEqual({ exists: true });
    expect(await service.validatePath(path.join(home, 'nope.duckdb'))).toEqual({ exists: false });
    expect(await service.validatePath(path.join(home, 'missing', 'nested.duckdb'))).toEqual({ exists: false });
  });

  it('treats a blank path as non existing', async () => {
    const { service } = await fixture('validate-blank');
    expect(await service.validatePath('')).toEqual({ exists: false });
    expect(await service.validatePath('   ')).toEqual({ exists: false });
    expect(await service.validatePath(null)).toEqual({ exists: false });
    expect(await service.validatePath(undefined)).toEqual({ exists: false });
  });

  it('normalises traversal segments out of the answer', async () => {
    const { service, home } = await fixture('validate-traversal');
    await fs.mkdir(home, { recursive: true });
    expect(await service.validatePath(`${home}${path.sep}..${path.sep}${path.basename(home)}`)).toEqual({
      exists: true,
    });
    expect(await service.validatePath('../../etc/passwd')).toEqual({ exists: false });
  });
});

describe('SystemService.import-paths', () => {
  it('copies the picked files into the profile and answers with ids', async () => {
    const { service, paths, discord } = await fixture('import');
    const first = await writeFile(path.join(root, 'import', 'src', 'race 一.duckdb'), 'one');
    const second = await writeFile(path.join(root, 'import', 'src', 'race two.duckdb'), 'two');

    const response = await service.importPaths([first, second], 'guest');
    expect(response).toEqual({
      status: 'success',
      id: 'race two.duckdb',
      ids: ['race 一.duckdb', 'race two.duckdb'],
      message: 'Imported 2 file(s)',
    });
    expect(await listNames(paths.profileDataDir('guest'))).toEqual(['race two.duckdb', 'race 一.duckdb']);
    expect(await fs.readFile(path.join(paths.profileDataDir('guest'), 'race 一.duckdb'), 'utf8')).toBe('one');
    expect(discord).toEqual({ getThreadAttachments: 0, downloadFile: 0 });
  });

  it('defaults an absent profile id to guest', async () => {
    const { service, paths } = await fixture('import-guest');
    const source = await writeFile(path.join(root, 'import-guest', 'src', 's.duckdb'));
    expect(await service.importPaths([source], '   ')).toMatchObject({ id: 's.duckdb' });
    expect(await listNames(paths.profileDataDir('guest'))).toEqual(['s.duckdb']);
    expect(await listNames(paths.profileDataDir('   '))).toEqual([]);
  });

  it('rejects empty lists, relative paths, missing files and non-duckdb picks', async () => {
    const { service } = await fixture('import-errors');
    await expect(service.importPaths([], 'guest')).rejects.toMatchObject({ status: 400, message: 'No files selected' });
    await expect(service.importPaths(null, 'guest')).rejects.toMatchObject({
      status: 400,
      message: 'No files selected',
    });
    await expect(service.importPaths(['relative/race.duckdb'], 'guest')).rejects.toMatchObject({
      status: 400,
      message: 'Source path must be absolute: relative/race.duckdb',
    });
    await expect(service.importPaths([path.join(root, 'import-errors', 'gone.duckdb')], 'guest')).rejects.toMatchObject({
      status: 400,
      message: `Source file not found: ${path.join(root, 'import-errors', 'gone.duckdb')}`,
    });
    const text = await writeFile(path.join(root, 'import-errors', 'src', 'notes.txt'));
    await expect(service.importPaths([text], 'guest')).rejects.toMatchObject({
      status: 400,
      message: `Only .duckdb files are allowed: ${text}`,
    });
  });
});

describe('SystemService.pick-and-upload', () => {
  it('reports the headless 400 when no native dialog bridge is injected', async () => {
    const { service } = await fixture('pick-headless');
    await expect(service.pickAndUpload({ path: root }, 'guest')).rejects.toMatchObject({
      status: 400,
      message: 'Native file picker is unavailable in headless mode',
    });
  });

  it('answers cancelled when the dialog returns nothing', async () => {
    const { service } = await fixture('pick-cancel', { dialog: async () => [] });
    expect(await service.pickAndUpload({ path: root }, 'guest')).toEqual({ status: 'cancelled' });
  });

  it('hands the request to the bridge and imports what came back', async () => {
    let seen: OpenPathRequest | null = null;
    const picked = await writeFile(path.join(root, 'pick-import', 'src', 'race one.duckdb'), 'race');
    const { service, paths } = await fixture('pick-import', {
      dialog: async (request) => {
        seen = request;
        return [picked];
      },
    });

    const request: OpenPathRequest = { path: root, x: 10, y: 20, width: 400, height: 300 };
    const response = await service.pickAndUpload(request, 'alice');
    expect(seen).toEqual(request);
    expect(response).toEqual({
      status: 'success',
      id: 'race one.duckdb',
      ids: ['race one.duckdb'],
      message: 'Imported 1 file(s)',
    });
    expect(await listNames(paths.profileDataDir('alice'))).toEqual(['race one.duckdb']);
  });

  it('propagates a failing bridge as the picker 500', async () => {
    const { service } = await fixture('pick-fail', {
      dialog: async () => {
        throw new Error('dialog crashed');
      },
    });
    await expect(service.pickAndUpload({}, 'guest')).rejects.toMatchObject({
      status: 500,
      message: 'Native file picker failed: dialog crashed',
    });
  });
});

describe('SystemService.steering-wheels', () => {
  it('returns the scanned categories verbatim', async () => {
    const wheels = path.join(root, 'wheels');
    await writeFile(path.join(wheels, 'alpha.png'));
    await writeFile(path.join(wheels, 'GT3', 'B.jpg'));
    await writeFile(path.join(wheels, 'GT3', 'a.jpeg'));
    await writeFile(path.join(wheels, 'GT3', 'ignored.txt'));
    const { service } = await fixture('wheels', { wheelDir: wheels });

    expect(await service.steeringWheels()).toEqual({
      categories: {
        GT3: [
          { name: 'a', path: `GT3/a.jpeg` },
          { name: 'B', path: 'GT3/B.jpg' },
        ],
        Root: [{ name: 'alpha', path: 'alpha.png' }],
      },
    });
  });

  it('returns an empty catalogue when the wheel folder is missing', async () => {
    const { service } = await fixture('wheels-missing', {
      wheelDir: path.join(root, 'no-such-wheel-dir'),
    });
    expect(await service.steeringWheels()).toEqual({ categories: {} });
  });
});

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}
