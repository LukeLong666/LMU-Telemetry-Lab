import type { AppInstance } from './app-instance.js';
import type { AppContext } from '../context.js';
import { ApiException } from './error.js';
import { writeTelemetryJson, writableSink } from './telemetry-writer.js';
import {
  intParamOrDefault,
  optionalIntParam,
  pathParam,
  profileIdParam,
} from './route-helpers.js';

/**
 * Port of TelemetryController.java + TelemetryJsonWriter.
 *
 * Everything the service can reject (unknown session, lap or stint) happens before the
 * response is hijacked, so those errors still travel through the JSON error handler. After
 * `reply.hijack()` the socket is ours: a client hang-up is swallowed by the writer, any
 * other failure destroys the socket because headers are already on the wire.
 */
export function registerTelemetryRoutes(app: AppInstance, ctx: AppContext): void {
  app.get('/api/v1/sessions/:sessionId/telemetry', async (request, reply) => {
    const frequency = intParamOrDefault(request, 'freq', 60);
    if (frequency < 1 || frequency > 1000) {
      throw new ApiException(400, 'freq must be between 1 and 1000');
    }
    const result = await ctx.telemetryService.load(
      profileIdParam(request),
      pathParam(request, 'sessionId'),
      frequency,
      optionalIntParam(request, 'stint_id'),
      optionalIntParam(request, 'lap_id'),
    );

    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    try {
      await writeTelemetryJson(
        writableSink(reply.raw, { logger: ctx.logger }),
        result.frame,
        result.suspensionBaselines,
      );
      reply.raw.end();
    } catch (error) {
      ctx.logger.error({ err: error }, 'Telemetry response failed after headers were sent');
      reply.raw.destroy();
    }
  });
}
