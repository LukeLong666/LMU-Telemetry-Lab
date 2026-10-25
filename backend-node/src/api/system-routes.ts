import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import type { OpenPathRequest } from './dto.js';
import {
  bodyObject,
  bodyString,
  bodyStringArray,
  profileIdParam,
  requiredBodyObject,
  requiredParam,
} from './route-helpers.js';

/** Port of SystemController.java. */
export function registerSystemRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/system/validate-path', async (request) => {
    return ctx.systemService.validatePath(requiredParam(request, 'path'));
  });

  app.post('/api/v1/system/open-path', async (request) => {
    return ctx.systemService.openPath(bodyString(bodyObject(request), 'path'));
  });

  app.post('/api/v1/system/import-paths', async (request) => {
    const body = requiredBodyObject(request);
    return ctx.systemService.importPaths(
      bodyStringArray(body, 'paths'),
      bodyString(body, 'profile_id'),
    );
  });

  app.post('/api/v1/system/pick-and-upload', async (request) => {
    return ctx.systemService.pickAndUpload(openPathRequest(request.body), profileIdParam(request));
  });

  app.get('/api/v1/steering-wheels', async () => ctx.systemService.steeringWheels());
}

/** `@RequestBody(required = false) OpenPathRequest`: no body at all stays null. */
function openPathRequest(body: unknown): OpenPathRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const source = body as Record<string, unknown>;
  return {
    path: bodyString(source, 'path'),
    x: optionalNumber(source, 'x'),
    y: optionalNumber(source, 'y'),
    width: optionalNumber(source, 'width'),
    height: optionalNumber(source, 'height'),
  };
}

function optionalNumber(body: Record<string, unknown>, name: string): number | null {
  const value = body[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
