import type { FastifyError } from 'fastify';
import type { AppInstance } from './app-instance.js';
import type { Logger } from '../lib/log.js';

/** Business errors surfaced to the client with an explicit HTTP status. */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiException';
  }
}

export class NoSuchFileError extends Error {
  constructor(readonly file: string) {
    super(`Not found: ${file}`);
    this.name = 'NoSuchFileError';
  }
}

interface ErrorWithCode extends Error {
  code?: string;
  path?: string;
  statusCode?: number;
  body?: unknown;
}

function isSizeError(error: ErrorWithCode): boolean {
  if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_PARTS_LIMIT') return true;
  const fastifyError = error as FastifyError;
  return fastifyError.statusCode === 413;
}

function isNotFoundRouteError(error: ErrorWithCode): boolean {
  return error.code === 'FST_ERR_NOT_FOUND';
}

/**
 * Keeps FastAPI's error shape: {"detail": "..."}. Mirrors GlobalExceptionHandler.java.
 */
export function registerErrorHandler(app: AppInstance, logger: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    const err = error as ErrorWithCode;

    if (err instanceof ApiException) {
      return reply.status(err.status).type('application/json').send({ detail: err.message });
    }
    if (err instanceof NoSuchFileError) {
      return reply.status(404).type('application/json').send({ detail: err.message });
    }
    if (isNotFoundRouteError(err)) {
      return reply.status(404).type('application/json').send({ detail: 'Not Found' });
    }
    if (isSizeError(err)) {
      return reply.status(413).type('application/json').send({ detail: 'File too large' });
    }
    // Fastify's own client errors (malformed JSON, unsupported content type, ...) carry a 4xx
    // status; the fallback below would turn them into 500s, unlike Spring.
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .type('application/json')
        .send({ detail: err.message || 'Bad Request' });
    }
    if (err.code === 'ENOENT') {
      const file = err.path === undefined ? null : String(err.path);
      return reply
        .status(404)
        .type('application/json')
        .send({ detail: file === null ? 'Not found' : `Not found: ${file}` });
    }
    if (err.code !== undefined && err.code.startsWith('E')) {
      logger.error({ err }, 'I/O error');
      return reply.status(500).type('application/json').send({ detail: err.message || 'I/O error' });
    }

    logger.error({ err }, 'Unhandled error');
    return reply.status(500).type('application/json').send({ detail: 'Internal Server Error' });
  });
}
