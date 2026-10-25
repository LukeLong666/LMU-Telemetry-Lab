import fs from 'node:fs';
import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import {
  attachmentDisposition,
  pathIntParam,
  pathParam,
  profileIdParam,
  queryValue,
} from './route-helpers.js';

/** Port of ExportController.java. */
export function registerExportRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/sessions/:sessionId/export/lap/:lapNumber', async (request, reply) => {
    const result = await ctx.lapExportService.export(
      profileIdParam(request),
      pathParam(request, 'sessionId'),
      pathIntParam(request, 'lapNumber'),
      queryValue(request, 'custom_car_model') ?? null,
    );

    const stat = await fs.promises.stat(result.path);
    return reply
      .type('application/octet-stream')
      .header('Content-Disposition', attachmentDisposition(result.filename))
      .header('Content-Length', String(stat.size))
      .send(fs.createReadStream(result.path));
  });
}
