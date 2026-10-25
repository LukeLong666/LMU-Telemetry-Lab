import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import { PathSafety } from '../infra/fs/path-safety.js';
import { attachmentDisposition, pathParam, profileIdParam, queryValue } from './route-helpers.js';

/** Port of SetupController.java. */
export function registerSetupRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/sessions/:sessionId/setup', async (request) => {
    return ctx.setupService.getSetup(profileIdParam(request), pathParam(request, 'sessionId'));
  });

  app.get('/api/v1/sessions/:sessionId/setup/export', async (request, reply) => {
    const sessionId = pathParam(request, 'sessionId');
    // Java calls the repository directly here, not SessionService.
    const database = await ctx.sessionRepository.resolve(profileIdParam(request), sessionId);
    const content = await ctx.svmExporter.generate(database);
    const metadata = await ctx.setupService.readMetadata(database);

    const layoutName = requireString(getOrDefault(metadata, 'TrackLayout', 'Layout'), 'TrackLayout')
      .replaceAll(' ', '-')
      .replaceAll(/[\\/*?:"<>|]/g, '');
    const rawCar = getOrDefault(metadata, 'CarName', '');
    const rawClass = getOrDefault(metadata, 'CarClass', '');
    const customCarModel = queryValue(request, 'custom_car_model') ?? null;
    const carModel = (
      customCarModel !== null && customCarModel.trim() !== ''
        ? customCarModel
        : ctx.carCatalog.getCarInfo(rawCar, rawClass).modelName
    ).replaceAll(' ', '-');
    const recordingTime = getOrDefault(metadata, 'RecordingTime', PathSafety.stripDuckDb(sessionId));
    const filename = `${layoutName}_${carModel}_${recordingTime}_setup.svm`;

    return reply
      // Spring's `new MediaType("text", "plain", UTF_8)` has no space before `charset`.
      .header('Content-Type', 'text/plain;charset=UTF-8')
      .header('Content-Disposition', attachmentDisposition(filename))
      .send(content);
  });
}

/** Java's `Map.getOrDefault`: a key mapped to null stays null, which `String.replace` rejects. */
function getOrDefault(
  metadata: Map<string, string | null>,
  key: string,
  fallback: string,
): string | null {
  return metadata.has(key) ? (metadata.get(key) ?? null) : fallback;
}

function requireString(value: string | null, key: string): string {
  if (value === null) {
    throw new TypeError(
      `Cannot invoke "String.replace(CharSequence, CharSequence)" on the null metadata value "${key}"`,
    );
  }
  return value;
}
