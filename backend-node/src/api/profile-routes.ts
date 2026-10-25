/**
 * Port of ProfileController.java (6 endpoints under /api/v1/profiles).
 *
 * Response envelopes are the controller's own `LinkedHashMap`s, so the JSON keeps Java's key
 * order: `{profiles}`, `{status}`, `{avatar_url}`. The avatar route is the only multipart one.
 */
import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import type { CreateProfileRequest, UpdateProfileRequest } from './dto.js';
import {
  bodyObject,
  pathParam,
  receiveUpload,
  type ReceivedUpload,
} from './route-helpers.js';

export function registerProfileRoutes(app: AppInstance, ctx: AppContext): void {
  const service = ctx.profileService;

  app.get('/api/v1/profiles', async () => {
    return { profiles: await service.list() };
  });

  app.post('/api/v1/profiles', async (request) => {
    const body = bodyObject(request) as Partial<CreateProfileRequest>;
    return service.create(typeof body.name === 'string' ? body.name : null);
  });

  app.post('/api/v1/profiles/reorder', async (request) => {
    const body = bodyObject(request);
    const ids = Array.isArray(body.profile_ids)
      ? body.profile_ids.map((id) => String(id))
      : [];
    return { profiles: await service.reorder(ids) };
  });

  app.delete('/api/v1/profiles/:profileId', async (request) => {
    await service.delete(pathParam(request, 'profileId'));
    return { status: 'success' };
  });

  app.put('/api/v1/profiles/:profileId', async (request) => {
    const body = bodyObject(request) as Partial<UpdateProfileRequest>;
    await service.update(
      pathParam(request, 'profileId'),
      typeof body.name === 'string' ? body.name : null,
    );
    return { status: 'success' };
  });

  app.post('/api/v1/profiles/:profileId/avatar', async (request) => {
    const upload = await receiveUpload(request, 'Avatar file is required');
    return uploadAvatar(service, pathParam(request, 'profileId'), upload);
  });
}

async function uploadAvatar(
  service: AppContext['profileService'],
  profileId: string,
  upload: ReceivedUpload,
): Promise<{ avatar_url: string }> {
  try {
    return { avatar_url: await service.uploadAvatar(profileId, upload.file) };
  } finally {
    upload.close();
  }
}
