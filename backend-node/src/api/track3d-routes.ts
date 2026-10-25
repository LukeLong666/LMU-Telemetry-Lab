import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import { ApiException } from './error.js';
import { optionalIntParam, pathParam, profileIdParam, requiredIntParam } from './route-helpers.js';

/** Port of Track3DController.java. */
export function registerTrack3DRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/sessions/:sessionId/3d-track', async (request) => {
    const lap = requiredIntParam(request, 'lap');
    if (lap < 0) {
      throw new ApiException(400, 'lap must be >= 0');
    }
    return ctx.track3DService.build(
      profileIdParam(request),
      pathParam(request, 'sessionId'),
      lap,
      optionalIntParam(request, 'stint'),
    );
  });
}
