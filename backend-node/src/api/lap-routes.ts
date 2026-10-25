import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import { defaultedParam, pathParam, profileIdParam, requiredParam } from './route-helpers.js';

/** Port of LapController.java. */
export function registerLapRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/sessions/:sessionId/laps', async (request) => {
    const database = await ctx.sessionService.resolve(
      profileIdParam(request),
      pathParam(request, 'sessionId'),
    );
    // Java calls the single-argument overload, i.e. the path-only header cache key.
    return ctx.lapService.header(database);
  });

  app.get('/api/v1/reference-laps', async (request) => {
    const laps = await ctx.referenceLapService.find(
      profileIdParam(request),
      requiredParam(request, 'track_name'),
      defaultedParam(request, 'track_layout'),
      requiredParam(request, 'car_class'),
    );
    return { laps };
  });
}
