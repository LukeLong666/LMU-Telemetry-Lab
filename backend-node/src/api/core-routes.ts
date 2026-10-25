import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { AppInstance } from './app-instance.js';
import type { AppPaths } from '../infra/fs/app-paths.js';
import type { Env } from '../config/env.js';

const NOT_FOUND = { detail: 'Not Found' } as const;

function listData(dataRoot: string): string[] {
  try {
    if (!fs.statSync(dataRoot).isDirectory()) return [];
    return fs
      .readdirSync(dataRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function registerHealthRoutes(app: AppInstance, env: Env): void {
  app.get('/health', async (_request, reply) => {
    return reply
      .type('application/json')
      .send({ status: 'ok', service: 'antigravity-backend', version: env.version });
  });

  // The Python backend reports a stale 1.4.3 here; kept for contract parity with
  // HealthController.apiHealth().
  app.get('/api/v1/health', async (_request, reply) => {
    return reply
      .type('application/json')
      .send({ status: 'ok', service: 'antigravity-backend', version: '1.4.3' });
  });

  app.get('/api/v1/ping', async (_request, reply) => {
    return reply.type('application/json').send({ status: 'pong', message: 'API is reachable' });
  });
}

export function registerDebugRoutes(app: AppInstance, paths: AppPaths): void {
  app.get('/api/v1/debug/env', async (_request, reply) => {
    return reply.type('application/json').send({
      is_frozen: false,
      sys_executable: process.execPath,
      os_getcwd: process.cwd(),
      APP_DATA_ROOT: paths.dataRoot,
      APP_DATA_ROOT_exists: isDirectory(paths.dataRoot),
      files_in_data: listData(paths.dataRoot),
      env_duckdb_data_dir: process.env.DUCKDB_DATA_DIR ?? null,
    });
  });
}

/**
 * Serves frontend/dist like Java's IndexController + FrontendResourceController.
 * Root-level and nested assets are resolved explicitly so URL-encoded paths such as
 * `/steering wheel/foo.png` keep working.
 */
export function registerFrontendRoutes(app: AppInstance, paths: AppPaths): void {
  const root = path.resolve(paths.frontendDir);

  app.get('/', async (_request, reply) => sendFile(reply, path.join(root, 'index.html'), 'text/html'));
  app.get('/index.html', async (_request, reply) =>
    sendFile(reply, path.join(root, 'index.html'), 'text/html'),
  );

  for (const prefix of ['/assets/', '/country_flag/', '/logos/', '/steering wheel/']) {
    app.get(`${prefix}*`, async (request, reply) => sendUrlFile(request.url, reply, root));
  }

  // Any other top-level file (favicon, manifests, root images).
  app.get('/:file', async (request, reply) => sendUrlFile(request.url, reply, root));
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function sendFile(reply: FastifyReply, file: string, contentType: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return reply.status(404).type('application/json').send({
      detail: 'Frontend build not found; run the Vite dev server or build frontend/dist',
    });
  }
  return reply.type(contentType).send(fs.createReadStream(file));
}

async function sendUrlFile(url: string, reply: FastifyReply, root: string) {
  const decoded = decodeURIComponent(url.split('?')[0]);
  if (decoded === '/' || decoded === '') {
    return reply.status(404).type('application/json').send(NOT_FOUND);
  }
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const file = path.resolve(root, relative);
  const inside = path.relative(root, file);
  if (inside.startsWith('..') || path.isAbsolute(inside) || inside === '') {
    return reply.status(404).type('application/json').send(NOT_FOUND);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return reply.status(404).type('application/json').send(NOT_FOUND);
  }
  return reply.type(contentTypeFor(file)).send(fs.createReadStream(file));
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
