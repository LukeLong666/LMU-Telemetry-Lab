import type { FastifyInstance } from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../lib/log.js';

/**
 * Passing a pre-built pino instance through `loggerInstance` re-types Fastify's logger
 * generic, so every route helper must share the same concrete instance type.
 */
export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
