/**
 * Shared plumbing for the route plugins: Spring's `@RequestParam` / `@RequestBody` /
 * `@RequestPart` resolution, and the `Content-Disposition` header Spring builds for the two
 * download endpoints.
 *
 * Java resolves a missing required parameter into an exception the catch-all advice turns
 * into a 500; the Node port validates at the boundary and answers 400 `{detail}` instead
 * (documented in PORTING_LOG). Everything else - the `profile_id` default, the empty-string
 * default of `track_layout`, the nullable `stint`/`lap_id` integers - is Java's.
 */
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { Readable } from 'node:stream';
import { ApiException } from './error.js';
import type { IncomingFile } from '../infra/fs/session-repository.js';

/** Every controller's `@RequestParam(defaultValue = "guest")`. */
export const GUEST_PROFILE = 'guest';

/** Spring's `spring.servlet.multipart.max-file-size: 2GB`. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Fastify's default query/flat-body objects, narrowed for reading one value at a time. */
function lookup(source: unknown, name: string): unknown {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return undefined;
  }
  return (source as Record<string, unknown>)[name];
}

/** Spring takes the first value when a parameter repeats; so does this. */
export function queryValue(request: FastifyRequest, name: string): string | undefined {
  const raw = lookup(request.query, name);
  if (Array.isArray(raw)) {
    return raw.length === 0 ? undefined : String(raw[0]);
  }
  return raw === undefined ? undefined : String(raw);
}

/** `@RequestParam(name = "profile_id", defaultValue = "guest")`. */
export function profileIdParam(request: FastifyRequest): string {
  return queryValue(request, 'profile_id') ?? GUEST_PROFILE;
}

/** `@RequestParam(name)` without a default: absent -> 400 instead of Spring's catch-all 500. */
export function requiredParam(request: FastifyRequest, name: string): string {
  const value = queryValue(request, name);
  if (value === undefined) {
    throw new ApiException(400, `${name} is required`);
  }
  return value;
}

/** `@RequestParam(name = ..., defaultValue = "")`. */
export function defaultedParam(request: FastifyRequest, name: string, fallback = ''): string {
  return queryValue(request, name) ?? fallback;
}

/**
 * `@RequestParam Integer`: an absent or empty value is null (Java's `required = false`),
 * anything not written as an integer is rejected like `Integer.valueOf` would.
 */
export function optionalIntParam(request: FastifyRequest, name: string): number | null {
  const value = queryValue(request, name);
  if (value === undefined || value === '') {
    return null;
  }
  return parseInteger(value, name);
}

/** `@RequestParam int`: required, and a non-numeric value is a client error. */
export function requiredIntParam(request: FastifyRequest, name: string): number {
  const value = queryValue(request, name);
  if (value === undefined) {
    throw new ApiException(400, `${name} is required`);
  }
  return parseInteger(value, name);
}

/** `@RequestParam(name, defaultValue = "60") int`: absent means the default, bad input is a 400. */
export function intParamOrDefault(
  request: FastifyRequest,
  name: string,
  fallback: number,
): number {
  const value = queryValue(request, name);
  return value === undefined || value === '' ? fallback : parseInteger(value, name);
}

function parseInteger(value: string, name: string): number {
  // `Integer.valueOf` accepts an optional sign and decimal digits only; Number() would also
  // take "1e3", " 1 " and "0x10".
  if (!/^[+-]?\d+$/.test(value)) {
    throw new ApiException(400, `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiException(400, `${name} must be an integer`);
  }
  return parsed;
}

/** `@PathVariable String`. Fastify already decoded the segment. */
export function pathParam(request: FastifyRequest, name: string): string {
  const value = lookup(request.params, name);
  return value === undefined ? '' : String(value);
}

/** `@PathVariable int`: Spring's type mismatch is a 400, so a non-numeric segment is too. */
export function pathIntParam(request: FastifyRequest, name: string): number {
  return parseInteger(pathParam(request, name), name);
}

/** `@RequestBody SomeRecord`: the flat JSON object, or `{}` when the client sent none. */
export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * `@RequestBody SomeRecord` without `required = false`. Spring rejects a request with no body
 * before the controller runs; the routes that check `request == null` themselves keep the
 * service's own message instead - see the callers.
 */
export function requiredBodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiException(400, 'Request body is required');
  }
  return body as Record<string, unknown>;
}

/** The request body as a string field, with Java's "absent means null" semantics. */
export function bodyString(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === 'string' ? value : null;
}

/** The request body as a number field; Java's primitive `int` would default to 0. */
export function bodyNumber(body: Record<string, unknown>, name: string, fallback = 0): number {
  const value = body[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The request body as a boolean field; Jackson's primitive `boolean` defaults to false. */
export function bodyBoolean(body: Record<string, unknown>, name: string): boolean {
  return body[name] === true;
}

/** The request body as a string array, or null when it is not an array of strings. */
export function bodyStringArray(body: Record<string, unknown>, name: string): string[] | null {
  const value = body[name];
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => String(entry));
}

/** An open multipart part whose stream is safe to hand to a service. */
export interface ReceivedUpload {
  readonly file: IncomingFile;
  /** Releases the part when the service rejected it before consuming the stream. */
  close(): void;
}

/**
 * `@RequestPart("file") MultipartFile`. The repository only needs the declared size to
 * reject an empty upload, so the first chunk is pulled here: no bytes means the same
 * `File is required` Java's `MultipartFile.isEmpty()` produced, and the rest of the body
 * streams straight through to the service afterwards.
 */
export async function receiveUpload(
  request: FastifyRequest,
  emptyMessage = 'File is required',
): Promise<ReceivedUpload> {
  if (!request.isMultipart()) {
    throw new ApiException(400, emptyMessage);
  }
  let part: MultipartFile | undefined;
  try {
    part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  } catch (error) {
    throw new ApiException(400, emptyMessage, { cause: error });
  }
  if (part === undefined) {
    throw new ApiException(400, emptyMessage);
  }
  const received = part;
  const stream = await nonEmptyStream(received, emptyMessage);
  return {
    file: { filename: received.filename, stream, size: null },
    close(): void {
      received.file.destroy();
    },
  };
}

async function nonEmptyStream(part: MultipartFile, emptyMessage: string): Promise<Readable> {
  const iterator = part.file[Symbol.asyncIterator]();
  let first: IteratorResult<Buffer>;
  try {
    first = await iterator.next();
  } catch (error) {
    throw new ApiException(400, emptyMessage, { cause: error });
  }
  if (first.done === true) {
    throw new ApiException(400, emptyMessage);
  }
  const head = first.value;

  async function* body(): AsyncGenerator<Buffer> {
    yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  return Readable.from(body());
}

/**
 * `ContentDisposition.attachment().filename(name, UTF_8)`. Plain ASCII names stay a quoted
 * `filename=`; a non-ASCII name gets the RFC 5987 form as well, which is what browsers and
 * the frontend's download helper read.
 */
export function attachmentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  if (ascii === filename) {
    return `attachment; filename="${ascii}"`;
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
