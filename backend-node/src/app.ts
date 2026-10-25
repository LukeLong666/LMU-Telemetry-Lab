import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import type { AppInstance } from './api/app-instance.js';
import type { AppContext, AppContextOptions } from './context.js';
import { buildContext } from './context.js';
import { registerErrorHandler } from './api/error.js';
import {
  contentTypeFor,
  registerDebugRoutes,
  registerFrontendRoutes,
  registerHealthRoutes,
} from './api/core-routes.js';
import { registerDiscordRoutes } from './api/discord-routes.js';
import { registerExportRoutes } from './api/export-routes.js';
import { registerLapRoutes } from './api/lap-routes.js';
import { registerProfileRoutes } from './api/profile-routes.js';
import { registerSessionRoutes } from './api/session-routes.js';
import { registerSetupRoutes } from './api/setup-routes.js';
import { registerSystemRoutes } from './api/system-routes.js';
import { registerTelemetryRoutes } from './api/telemetry-routes.js';
import { registerTrack3DRoutes } from './api/track3d-routes.js';
import { MAX_UPLOAD_BYTES } from './api/route-helpers.js';
import { PathSafety } from './infra/fs/path-safety.js';

const ALLOWED_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function createApp(
  options: AppContextOptions = {},
): Promise<{ app: AppInstance; ctx: AppContext }> {
  const ctx = await buildContext(options);

  const app = Fastify({
    loggerInstance: ctx.logger,
    bodyLimit: 2 * 1024 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Mirrors Spring's allowedOriginPatterns("http://localhost:[*]", "http://127.0.0.1:[*]").
      callback(null, origin === undefined ? false : ALLOWED_ORIGIN.test(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['*'],
    exposedHeaders: ['Content-Disposition'],
  });

  // Spring's servlet multipart limit; `request.file()` enforces it per part.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  registerErrorHandler(app, ctx.logger);

  registerHealthRoutes(app, ctx.env);
  registerDebugRoutes(app, ctx.paths);
  registerProfileDataRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerLapRoutes(app, ctx);
  registerSetupRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerTelemetryRoutes(app, ctx);
  registerTrack3DRoutes(app, ctx);
  registerDiscordRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerFrontendRoutes(app, ctx.paths);

  // Python's 404 handler serves index.html for client-side routes but returns JSON
  // for /api/* misses; same behavior here.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).type('application/json').send({ detail: 'Not Found' });
    }
    const index = path.join(ctx.paths.frontendDir, 'index.html');
    if (fs.existsSync(index)) {
      return reply.type('text/html').send(fs.createReadStream(index));
    }
    return reply.status(404).type('application/json').send({ detail: 'Not Found' });
  });

  return { app, ctx };
}

/** Java exposes the data root through WebConfig's /api/v1/profile-data/** resource handler. */
function registerProfileDataRoutes(app: AppInstance, ctx: AppContext): void {
  const prefix = '/api/v1/profile-data/';
  app.get(`${prefix}*`, async (request, reply) => {
    const url = decodeURIComponent(request.url.split('?')[0]);
    const relative = url.slice(prefix.length);
    if (relative === '') {
      return reply.status(404).type('application/json').send({ detail: 'Not Found' });
    }
    let file: string;
    try {
      file = PathSafety.resolveUnder(ctx.paths.dataRoot, relative);
    } catch {
      return reply.status(404).type('application/json').send({ detail: 'Not Found' });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return reply.status(404).type('application/json').send({ detail: 'Not Found' });
    }
    return reply.type(contentTypeFor(file)).send(fs.createReadStream(file));
  });
}

export { buildContext };
export type { AppContext, AppContextOptions };
