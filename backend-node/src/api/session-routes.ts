/**
 * Port of SessionController.java (4 endpoints under /api/v1/sessions).
 *
 * `profile_id` defaults to "guest" on every route, and the rename body's `new_name` is
 * snake_case exactly as the Java record's `@JsonProperty` declares it.
 */
import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import type { RenameSessionRequest } from './dto.js';
import {
  bodyObject,
  pathParam,
  profileIdParam,
  receiveUpload,
} from './route-helpers.js';

export function registerSessionRoutes(app: AppInstance, ctx: AppContext): void {
  const service = ctx.sessionService;

  app.get('/api/v1/sessions', async (request) => {
    return { sessions: await service.list(profileIdParam(request)) };
  });

  app.post('/api/v1/sessions/upload', async (request) => {
    const upload = await receiveUpload(request);
    try {
      const uploaded = await service.upload(profileIdParam(request), upload.file);
      return { id: uploaded.id, status: 'uploaded', size: uploaded.size };
    } finally {
      upload.close();
    }
  });

  app.post('/api/v1/sessions/:sessionId/rename', async (request) => {
    const sessionId = pathParam(request, 'sessionId');
    const body = bodyObject(request) as Partial<RenameSessionRequest>;
    const newName = typeof body.new_name === 'string' ? body.new_name : null;
    const renamed = await service.rename(profileIdParam(request), sessionId, newName);
    return { id: renamed, old_id: sessionId, status: 'renamed' };
  });

  app.delete('/api/v1/sessions/:sessionId', async (request) => {
    const sessionId = pathParam(request, 'sessionId');
    await service.delete(profileIdParam(request), sessionId);
    return { id: sessionId, status: 'deleted' };
  });
}
