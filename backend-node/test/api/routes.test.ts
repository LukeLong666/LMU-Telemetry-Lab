/**
 * Wiring tests for the Fastify route layer. The services themselves are covered by
 * test/application/*; what is asserted here is the Spring-to-Fastify translation: parameter
 * defaults, the `{detail}` error shape, status codes, multipart uploads and the fact that
 * `createApp` can actually assemble the whole object graph.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppInstance } from '../../src/api/app-instance.js';
import type { AppContext } from '../../src/context.js';
import { installSession } from '../application/fixtures.js';
import {
  CAR_CLASS,
  CAR_NAME,
  createFusionFixture,
  TRACK_LAYOUT,
  type DuckDbFixture,
} from '../helpers/duckdb-fixture.js';

const logger = pino({ level: 'silent' });

/** The fusion fixture copied into the guest profile, for the end-to-end read endpoints. */
const FIXTURE_SESSION = 'route-fixture.duckdb';

let root: string;
let app: AppInstance;
let ctx: AppContext;
let fixture: DuckDbFixture;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-routes-'));
  const created = await createApp({
    logger,
    env: {
      appHome: root,
      dataDir: path.join(root, 'data'),
      telemetryDir: '',
      frontendDir: path.join(root, 'frontend'),
      steeringWheelDir: path.join(root, 'wheels'),
      logFile: path.join(root, 'debug.log'),
      devMode: false,
    },
  });
  app = created.app;
  ctx = created.ctx;

  fixture = await createFusionFixture({
    metadata: { CarSetup: '{"VM_STEER_LOCK":{"available":true,"stringValue":"520 degrees"}}' },
  });
  await installSession(ctx.paths, 'guest', fixture.database, FIXTURE_SESSION, 1_700_000_000);
});

afterAll(async () => {
  await app.close();
  fixture.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function multipartBody(boundary: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('createApp wiring', () => {
  it('creates the guest profile during startup (ProfileService.init)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ profiles: Array<{ id: string; name: string }> }>();
    expect(body.profiles.map((profile) => profile.id)).toContain('guest');
    // The composition root also created the profile directory tree.
    expect(fs.existsSync(path.join(root, 'data', 'Data', 'guest', 'DuckDB_data'))).toBe(true);
    expect(ctx.paths.dataRoot).toBe(path.join(root, 'data'));
  });

  it('keeps the JSON 404 for unknown /api routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: 'Not Found' });
  });

  it('serves /api/v1/health with the stale Java version', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'antigravity-backend',
      version: '1.4.3',
    });
  });
});

describe('profiles routes', () => {
  it('creates and renames profiles through the JSON bodies', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'Route Test' },
    });
    expect(created.statusCode).toBe(200);
    const profile = created.json<{ id: string; name: string }>();
    expect(profile.name).toBe('Route Test');

    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/v1/profiles/${profile.id}`,
      payload: { name: 'Renamed' },
    });
    expect(renamed.json()).toEqual({ status: 'success' });

    const reordered = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles/reorder',
      payload: { profile_ids: [profile.id, 'guest'] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<{ profiles: Array<{ id: string }> }>().profiles[0].id).toBe(profile.id);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/profiles/${profile.id}` });
    expect(deleted.json()).toEqual({ status: 'success' });
  });

  it('stores an avatar uploaded as multipart and serves it through profile-data', async () => {
    const boundary = '----lmu-avatar-boundary';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles/guest/avatar',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'me.png', png),
    });

    expect(response.statusCode).toBe(200);
    const avatarUrl = response.json<{ avatar_url: string }>().avatar_url;
    // The mount is the data root, so the URL keeps the `Data/<profile>` segment.
    expect(avatarUrl).toMatch(/^\/api\/v1\/profile-data\/Data\/guest\/avatars\/avatar_\d+\.png$/);

    const fetched = await app.inject({ method: 'GET', url: avatarUrl });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.rawPayload).toEqual(png);
  });

  it('rejects an avatar with an unsupported extension', async () => {
    const boundary = '----lmu-avatar-bad-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles/guest/avatar',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'me.txt', Buffer.from('plain text')),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'Unsupported avatar file type' });
  });
});

describe('query and path parameters', () => {
  it('defaults profile_id to guest and resolves unknown sessions as 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions/missing.duckdb/laps' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: 'Session not found' });
  });

  it('rejects non-.duckdb session ids with the repository message', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions/notes.txt/laps' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'Only .duckdb files are supported' });
  });

  it('requires track_name and car_class on /reference-laps', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference-laps?car_class=GT3' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'track_name is required' });
  });

  it('applies the freq guard before touching the session', async () => {
    for (const freq of ['0', '1001', 'abc']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/missing.duckdb/telemetry?freq=${freq}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/freq must be( between 1 and 1000| an integer)/);
    }
  });

  it('rejects a negative lap on /3d-track and a missing lap', async () => {
    const negative = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/missing.duckdb/3d-track?lap=-1',
    });
    expect(negative.statusCode).toBe(400);
    expect(negative.json()).toEqual({ detail: 'lap must be >= 0' });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/missing.duckdb/3d-track',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ detail: 'lap is required' });
  });

  it('rejects a non-numeric lap path segment on the export route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/missing.duckdb/export/lap/latest',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'lapNumber must be an integer' });
  });
});

describe('session uploads (multipart)', () => {
  const boundary = '----lmu-route-test-boundary';

  it('streams a .duckdb file into the guest profile', async () => {
    const payload = multipartBody(boundary, 'route-test.duckdb', Buffer.from('not-a-database'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 'route-test.duckdb', status: 'uploaded', size: 14 });
    expect(
      fs.readFileSync(path.join(root, 'data', 'Data', 'guest', 'DuckDB_data', 'route-test.duckdb'), 'utf8'),
    ).toBe('not-a-database');
  });

  it('rejects a multipart upload whose file part is empty', async () => {
    const payload = multipartBody(boundary, 'empty.duckdb', Buffer.alloc(0));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'File is required' });
  });

  it('rejects a plain JSON body on the upload route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/upload',
      payload: { file: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: 'File is required' });
  });

  it('lists the uploaded file even when it is not a readable database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessions: Array<{ id: string; name: string }> }>();
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'route-test.duckdb', name: 'route-test' }),
        expect.objectContaining({ id: FIXTURE_SESSION, name: 'route-fixture' }),
      ]),
    );
  });

  it('renames and deletes the uploaded file', async () => {
    const renamed = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/route-test.duckdb/rename',
      payload: { new_name: 'route-renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({
      id: 'route-renamed.duckdb',
      old_id: 'route-test.duckdb',
      status: 'renamed',
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/sessions/route-renamed.duckdb',
    });
    expect(deleted.json()).toEqual({ id: 'route-renamed.duckdb', status: 'deleted' });
  });
});

describe('system routes', () => {
  it('validates paths without revealing them', async () => {
    const existing = await app.inject({
      method: 'GET',
      url: `/api/v1/system/validate-path?path=${encodeURIComponent(root)}`,
    });
    expect(existing.json()).toEqual({ exists: true });

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/system/validate-path?path=${encodeURIComponent(path.join(root, 'nope'))}`,
    });
    expect(missing.json()).toEqual({ exists: false });

    const absent = await app.inject({ method: 'GET', url: '/api/v1/system/validate-path' });
    expect(absent.statusCode).toBe(400);
    expect(absent.json()).toEqual({ detail: 'path is required' });
  });

  it('requires a body on /import-paths but accepts one on /pick-and-upload', async () => {
    const noBody = await app.inject({ method: 'POST', url: '/api/v1/system/import-paths' });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json()).toEqual({ detail: 'Request body is required' });

    // Headless mode: the picker itself answers 400, which is the plan's pinned deviation.
    const pick = await app.inject({ method: 'POST', url: '/api/v1/system/pick-and-upload' });
    expect(pick.statusCode).toBe(400);
    expect(pick.json()).toEqual({ detail: 'Native file picker is unavailable in headless mode' });
  });

  it('scans steering wheels from an empty directory', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/steering-wheels' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: {} });
  });
});

describe('discord routes', () => {
  it('reports an unconfigured bot', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/discord/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      is_configured: false,
      invite_url: 'https://discord.gg/your-invite-code',
    });
  });

  it('requires car_class on /discord/shares and a body on the download route', async () => {
    const shares = await app.inject({ method: 'GET', url: '/api/v1/discord/shares' });
    expect(shares.statusCode).toBe(400);
    expect(shares.json()).toEqual({ detail: 'car_class is required' });

    const download = await app.inject({
      method: 'POST',
      url: '/api/v1/discord/shares/download',
      payload: {},
    });
    expect(download.statusCode).toBe(400);
    expect(download.json()).toEqual({ detail: 'Telemetry URL and filename are required' });
  });

  it('rejects a share before any Discord call when the bot is not configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/missing.duckdb/discord/share',
      payload: { lap_number: 1, title: 't', content: 'c', attach_setup: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      detail: 'Discord Bot is not configured. Please check discord_config.json',
    });
  });
});

describe('end-to-end reads against a real session database', () => {
  it('returns the lap header for /laps', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/laps`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      metadata: { trackName: string };
      laps: Array<{ lap: number; startTime: number; endTime: number }>;
    }>();
    expect(body.metadata.trackName).toBe('Silverstone');
    expect(body.laps.map((lap) => [lap.lap, lap.startTime, lap.endTime])).toEqual([
      [0, 0, 30],
      [1, 30, 70],
      [2, 70, 120],
    ]);
  });

  it('streams the fused telemetry with a chunked JSON body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/telemetry?freq=10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json;charset=UTF-8');
    const body = response.json<Record<string, unknown> & {
      Time: number[];
      suspension_baselines: number[];
    }>();
    expect(body.Time).toHaveLength(1201);
    expect(body.Time[0]).toBe(0);
    expect(body.Time[1200]).toBe(120);
    expect(body.suspension_baselines).toHaveLength(4);
  });

  it('trims the stream to one lap and 404s an unknown lap', async () => {
    const trimmed = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/telemetry?freq=10&lap_id=1`,
    });
    expect(trimmed.statusCode).toBe(200);
    expect(trimmed.json<{ Time: number[] }>().Time).toHaveLength(401);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/telemetry?freq=10&lap_id=99`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ detail: 'Lap 99 not found' });
  });

  it('builds the 3D track for a lap', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/3d-track?lap=1`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      selectedLapInfo: { lap: number };
      baseMap: Array<{ x: number; y: number; z: number; d: number }>;
      racingLine: unknown[];
    }>();
    expect(body.selectedLapInfo.lap).toBe(1);
    expect(body.baseMap.length).toBeGreaterThan(0);
    expect(body.racingLine.length).toBeGreaterThan(0);
  });

  it('returns the setup groups', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/setup`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ setup: Record<string, unknown> }>();
    expect(Object.keys(body.setup)).toEqual([
      'powertrain',
      'wheelsAndBrakes',
      'suspension',
      'dampers',
      'chassisAndAero',
    ]);
  });

  it('serves the generated .svm as an attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/setup/export`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain;charset=UTF-8');
    expect(response.body).toContain('VehicleClassSetting=');

    const carModel = ctx.carCatalog.getCarInfo(CAR_NAME, CAR_CLASS).modelName.replaceAll(' ', '-');
    const disposition = response.headers['content-disposition'];
    expect(disposition).toContain(
      `filename="National-Circuit_${carModel}_route-fixture_setup.svm"`,
    );
    expect(TRACK_LAYOUT).toBe('National Circuit');
  });

  it('exports one lap as a downloadable DuckDB file', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${FIXTURE_SESSION}/export/lap/1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename=".+\.duckdb"$/);
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    expect(response.rawPayload.byteLength).toBe(Number(response.headers['content-length']));
    // Same storage header as the source session, i.e. a real DuckDB file was streamed back.
    const source = fs.readFileSync(path.join(ctx.paths.profileDataDir('guest'), FIXTURE_SESSION));
    expect(response.rawPayload.subarray(0, 4)).toEqual(source.subarray(0, 4));
  });

  it('computes reference laps from the session metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reference-laps?track_name=Silverstone&track_layout=National%20Circuit&car_class=LMGT3',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ laps: Array<{ sessionName: string }> }>();
    expect(body.laps.length).toBeGreaterThan(0);
  });
});
