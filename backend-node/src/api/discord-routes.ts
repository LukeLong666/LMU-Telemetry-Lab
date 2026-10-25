import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import type { DiscordDownloadRequest, DiscordShareRequest } from './dto.js';
import {
  bodyBoolean,
  bodyNumber,
  bodyString,
  pathParam,
  queryValue,
  requiredBodyObject,
  requiredParam,
} from './route-helpers.js';

/** Port of DiscordController.java. */
export function registerDiscordRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/discord/config', async () => ctx.discordService.config());

  app.get('/api/v1/discord/shares', async (request) => {
    return ctx.discordService.shares(requiredParam(request, 'car_class'));
  });

  app.post('/api/v1/discord/shares/download', async (request) => {
    const body = requiredBodyObject(request);
    return ctx.discordService.download(downloadRequest(body));
  });

  app.post('/api/v1/sessions/:sessionId/discord/share', async (request) => {
    const body = requiredBodyObject(request);
    // DiscordController.java:45 - the query parameter wins when it is present at all.
    const queryProfile = queryValue(request, 'profile_id');
    const profile = queryProfile !== undefined ? queryProfile : bodyString(body, 'profile_id');
    return ctx.discordService.share(
      profile,
      pathParam(request, 'sessionId'),
      shareRequest(body),
    );
  });
}

/** Jackson's defaults on an absent field: numbers 0, primitive booleans false, strings null. */
function shareRequest(body: Record<string, unknown>): DiscordShareRequest {
  return {
    lap_number: bodyNumber(body, 'lap_number'),
    title: bodyString(body, 'title') ?? '',
    content: bodyString(body, 'content') ?? '',
    attach_setup: bodyBoolean(body, 'attach_setup'),
    car_class: bodyString(body, 'car_class'),
    custom_car_model: bodyString(body, 'custom_car_model'),
    profile_id: bodyString(body, 'profile_id'),
    discord_handle: bodyString(body, 'discord_handle'),
  };
}

function downloadRequest(body: Record<string, unknown>): DiscordDownloadRequest {
  return {
    profile_id: bodyString(body, 'profile_id'),
    telemetry_url: bodyString(body, 'telemetry_url'),
    telemetry_filename: bodyString(body, 'telemetry_filename'),
    setup_url: bodyString(body, 'setup_url'),
    setup_filename: bodyString(body, 'setup_filename'),
  };
}
