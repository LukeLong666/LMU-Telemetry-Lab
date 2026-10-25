import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ApiException } from '../../../src/api/error.js';
import { AppPaths } from '../../../src/infra/fs/app-paths.js';
import { FilePicker } from '../../../src/infra/system/file-picker.js';
import { SteeringWheelScanner } from '../../../src/infra/system/steering-wheel-scanner.js';
import type { OpenPathRequest } from '../../../src/api/dto.js';
import type { Env } from '../../../src/config/env.js';

const logger = pino({ level: 'silent' });

function testEnv(root: string, steeringWheelDir: string): Env {
  return {
    port: 0,
    address: '127.0.0.1',
    devMode: true,
    dataDir: path.join(root, 'data'),
    telemetryDir: '',
    frontendDir: path.join(root, 'frontend', 'dist'),
    steeringWheelDir,
    version: 'test',
    logFile: path.join(root, 'backend_debug.log'),
    appHome: root,
  };
}

async function writeImage(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'x');
}

describe('SteeringWheelScanner', () => {
  it('groups images by folder, sorted, with URL-style paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-test-'));
    try {
      const wheels = path.join(root, 'wheels');
      await writeImage(path.join(wheels, 'beta.png'));
      await writeImage(path.join(wheels, 'alpha.PNG'));
      await writeImage(path.join(wheels, 'notes.txt'));
      await writeImage(path.join(wheels, 'GT3', 'B.png'));
      await writeImage(path.join(wheels, 'GT3', 'a.jpg'));
      await writeImage(path.join(wheels, 'GT3', 'nested', 'webp.webp'));
      await writeImage(path.join(wheels, 'a1', 'a2', 'a3', 'a4', 'a5', 'in.png'));
      await writeImage(path.join(wheels, 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'out.png'));

      const scanner = new SteeringWheelScanner(new AppPaths(testEnv(root, wheels), logger));
      const scan = await scanner.scan();

      expect(Object.keys(scan.categories)).toEqual([
        'GT3',
        path.join('GT3', 'nested'),
        'Root',
        path.join('a1', 'a2', 'a3', 'a4', 'a5'),
      ]);
      // Names sort case-insensitively (Java's String.CASE_INSENSITIVE_ORDER).
      expect(scan.categories.Root).toEqual([
        { name: 'alpha', path: 'alpha.PNG' },
        { name: 'beta', path: 'beta.png' },
      ]);
      expect(scan.categories.GT3).toEqual([
        { name: 'a', path: 'GT3/a.jpg' },
        { name: 'B', path: 'GT3/B.png' },
      ]);
      expect(scan.categories[path.join('GT3', 'nested')]).toEqual([
        { name: 'webp', path: 'GT3/nested/webp.webp' },
      ]);
      expect(scan.categories[path.join('a1', 'a2', 'a3', 'a4', 'a5')]).toEqual([
        { name: 'in', path: 'a1/a2/a3/a4/a5/in.png' },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty catalogue when the steering wheel folder is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-test-'));
    try {
      const scanner = new SteeringWheelScanner(
        new AppPaths(testEnv(root, path.join(root, 'nope')), logger),
      );
      expect(await scanner.scan()).toEqual({ categories: {} });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('FilePicker', () => {
  it('reports the same headless message as Java when no native dialog is injected', async () => {
    await expect(new FilePicker(undefined, logger).pick({ path: 'C:\\tmp' })).rejects.toMatchObject({
      status: 400,
      message: 'Native file picker is unavailable in headless mode',
    });
    await expect(new FilePicker(null, logger).pick(null)).rejects.toBeInstanceOf(ApiException);
  });

  it('hands the request through to the bridge and returns the selection', async () => {
    let seen: OpenPathRequest | null = null;
    const picker = new FilePicker(async (request) => {
      seen = request;
      return ['C:\\telemetry\\race.duckdb'];
    }, logger);

    const request: OpenPathRequest = { path: 'C:\\telemetry', x: 10, y: 20, width: 400, height: 300 };
    expect(await picker.pick(request)).toEqual(['C:\\telemetry\\race.duckdb']);
    expect(seen).toEqual(request);
    // A cancelled dialog is an empty selection, not an error (Java returned List.of()).
    expect(await new FilePicker(async () => [], logger).pick(null)).toEqual([]);
  });

  it('maps a failing bridge to a 500 with the Java wording', async () => {
    await expect(
      new FilePicker(async () => {
        throw new Error('boom');
      }, logger).pick({}),
    ).rejects.toMatchObject({ status: 500, message: 'Native file picker failed: boom' });
  });
});
