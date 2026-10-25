import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Fastify logs through pino; the file destination mirrors the Java backend's
 * `backend_debug.log` so operators keep a single log path across implementations.
 */
export function createLogger(logFile: string, appHome: string): Logger {
  const target = path.isAbsolute(logFile) ? logFile : path.resolve(appHome, logFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const fileStream = fs.createWriteStream(target, { flags: 'a' });
  const stream = pino.multistream([
    { level: 'info', stream: fileStream },
    { level: 'info', stream: process.stdout },
  ]);

  return pino(
    {
      level: process.env.LMU_LOG_LEVEL ?? 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );
}

export function child(logger: Logger, name: string): Logger {
  return logger.child({ module: name });
}
