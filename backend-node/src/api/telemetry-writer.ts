/**
 * Port of backend-java/src/main/java/com/lmutl/api/TelemetryJsonWriter.java (62 lines).
 *
 * This is the HTTP body of `GET /api/v1/sessions/{id}/telemetry`, the heaviest read of the
 * application: one fused grid at up to 60 Hz over a whole stint is 70k+ frames across 30-ish
 * channels, i.e. millions of numbers. The Java writer pushed them straight into
 * `response.getOutputStream()` through a Jackson `JsonGenerator`; the Node port pushes them
 * into a {@link TelemetrySink} in bounded chunks and never builds the payload as a string.
 *
 * Output shape (byte-for-byte the Java writer's, which is also the Python backend's, see
 * `backend/app/api/endpoints.py:1014-1028`): the frame's channels keyed by their own name in
 * `frame.channels` insertion order, then `suspension_baselines` last. There is no top-level
 * `frequency`/`time`/`channels` wrapper - the timeline travels as the "Time" channel the
 * fusion engine always emits first. Minified, no spaces:
 *
 *   {"Time":[0.0,0.1],"Ground Speed":[1.0,null],"Susp Pos":[[1.0,2.0,3.0,4.0]],
 *    "suspension_baselines":[0.0,0.0,0.0,0.0]}
 *
 * Jackson (`WriterBasedJsonGenerator.writeNumber(double)`) emits `String.valueOf(double)`, so
 * the number literals are Java's `Double.toString` - always a decimal point ("1.0", "-0.0"),
 * plain notation for 10^-3 <= |v| < 10^7 and `d.dddE<exp>` (uppercase `E`, no `+`) outside it.
 * `formatJavaDouble` reproduces that; `JSON.stringify` would not (it writes "1", "1e+20" and
 * turns NaN into null only as a side effect). NaN and both infinities become `null` because
 * {@link numberToken} checks `Number.isFinite` explicitly, exactly like `writeNumber` checks
 * `Double.isNaN(value) || Double.isInfinite(value)`.
 *
 * Node-only concerns the servlet container never had here:
 * - backpressure: `sink.write()` returning false means "queued beyond the high-water mark".
 *   The writer keeps buffering anyway at most until the next flush point and then awaits
 *   `sink.drain()`, so a slow client cannot make the process hold the whole response.
 * - the client hanging up mid-body: EPIPE / ERR_STREAM_DESTROYED / a destroyed `reply.raw`
 *   surface as a {@link ClientDisconnectedError}, which `writeTelemetryJson` swallows after
 *   logging. It must never reach the router as a 500 (headers are long gone) and must never
 *   become an uncaught 'error' event on the socket.
 */
import type { Writable } from 'node:stream';
import { Channel, type FusedFrame } from '../domain/types.js';
import type { Logger } from '../lib/log.js';

/**
 * A destination for the JSON byte stream: return `false` to signal backpressure (the writer
 * then awaits {@link TelemetrySink.drain} before writing more), return `void`/`true` when the
 * chunk was accepted. Throwing is reserved for "the peer is gone" - see
 * {@link ClientDisconnectedError}.
 */
export type TelemetryChunkWriter = (chunk: string) => boolean | void;

/** The full destination contract; only {@link TelemetrySink.write} is required. */
export interface TelemetrySink {
  /** Hand one chunk (never a partial token) to the destination. */
  write(chunk: string): boolean | void;
  /**
   * Optional: resolve once the destination accepted more data. Called only after `write`
   * returned false; a destination without backpressure can omit it.
   */
  drain?(): Promise<void> | void;
  /** Optional: cheap "the peer is gone" probe, checked before every flush. */
  isDestroyed?(): boolean;
}

/** Either a full {@link TelemetrySink} or the bare function form. */
export type TelemetryDestination = TelemetrySink | TelemetryChunkWriter;

/** Thrown by a destination that noticed the client vanished; swallowed by the writer. */
export class ClientDisconnectedError extends Error {
  override readonly name = 'ClientDisconnectedError';

  constructor(override readonly cause?: unknown) {
    super('Telemetry client disconnected before the response was complete');
  }
}

/** Error codes that mean "nobody is listening any more", never "the data is wrong". */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECLOSED',
  'ERR_STREAM_DISCONNECTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
  'ABORTED',
]);

/** Whether an error is a client hang-up (or a socket that died) rather than a real failure. */
export function isClientDisconnect(error: unknown): boolean {
  if (error instanceof ClientDisconnectedError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && DISCONNECT_CODES.has(code);
}

export interface TelemetryWriterOptions {
  /** Used to downgrade a client hang-up to a log line. */
  readonly logger?: Logger;
  /** Flush after this many buffered tokens (each token is one number or one separator). */
  readonly chunkTokens?: number;
  /** Flush after this many characters, so wide numbers cannot inflate a chunk. */
  readonly chunkChars?: number;
}

const DEFAULT_CHUNK_TOKENS = 4096;
const DEFAULT_CHUNK_CHARS = 32 * 1024;

/** The literal `null` Java's `writeNull()` produces. */
const NULL_TOKEN = 'null';

/**
 * Writes one fused frame as a stream of JSON chunks. Resolves when the document is complete
 * *or* the client went away part-way (that case is logged, not thrown); anything else -
 * including a non-disconnect failure from the destination - propagates so the caller sees a
 * real bug. The caller owns the stream lifecycle: `writeTelemetryJson` never ends it.
 */
export async function writeTelemetryJson(
  destination: TelemetryDestination,
  frame: FusedFrame,
  baselines: readonly number[],
  options: TelemetryWriterOptions = {},
): Promise<void> {
  const buffer = new ChunkBuffer(toSink(destination), options.chunkTokens, options.chunkChars);
  try {
    buffer.push('{');
    let firstKey = true;
    for (const channel of frame.channels.values()) {
      if (!firstKey) {
        buffer.push(',');
      }
      firstKey = false;
      buffer.push(quoteJsonString(channel.name));
      buffer.push(':');
      await writeChannel(buffer, channel);
    }
    // Java writes this field unconditionally, so an empty frame is `{"suspension_baselines":[]}`
    // rather than `{}` - and FusionEngine always supplies four baselines.
    if (!firstKey) {
      buffer.push(',');
    }
    buffer.push('"suspension_baselines":');
    await writeFlatNumbers(buffer, baselines);
    buffer.push('}');
    await buffer.drain();
  } catch (error) {
    if (!isClientDisconnect(error)) {
      throw error;
    }
    const logger = options.logger;
    if (logger !== undefined) {
      const cause = error instanceof ClientDisconnectedError ? error.cause : error;
      logger.debug({ err: cause }, 'Telemetry response aborted by the client');
    }
  }
}

/** `writeChannel`: flat array for width 1, per-frame sub-arrays for a wider channel. */
async function writeChannel(buffer: ChunkBuffer, channel: Channel): Promise<void> {
  if (channel.width === 1) {
    await writeFlatNumbers(buffer, channel.data);
    return;
  }
  // Java looped `wheel < channel.width()`, i.e. exactly the declared width per frame.
  const width = channel.width;
  const frames = Math.trunc(channel.frames());
  buffer.push('[');
  for (let frame = 0; frame < frames; frame++) {
    if (frame > 0) {
      buffer.push(',');
    }
    buffer.push('[');
    const base = frame * width;
    for (let component = 0; component < width; component++) {
      if (component > 0) {
        buffer.push(',');
      }
      buffer.push(numberToken(channel.data[base + component]));
    }
    buffer.push(']');
    if (buffer.full || buffer.backpressured) {
      await buffer.drain();
    }
  }
  buffer.push(']');
  if (buffer.full || buffer.backpressured) {
    await buffer.drain();
  }
}

/**
 * `[a,b,c]` over a slice of doubles (scalar channels and the baselines array). Reads the
 * `Float64Array` by index: no `Array.from`, no intermediate array of the same size.
 */
async function writeFlatNumbers(buffer: ChunkBuffer, values: ArrayLike<number>): Promise<void> {
  buffer.push('[');
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      buffer.push(',');
    }
    buffer.push(numberToken(values[i]));
    if (buffer.full || buffer.backpressured) {
      await buffer.drain();
    }
  }
  buffer.push(']');
  if (buffer.full || buffer.backpressured) {
    await buffer.drain();
  }
}

/** `writeNumber`: NaN and both infinities are `null`, everything else a Java literal. */
export function numberToken(value: number): string {
  return Number.isFinite(value) ? formatJavaDouble(value) : NULL_TOKEN;
}

/**
 * `Double.toString` for finite doubles (and Java's literals for the non-finite ones, so this
 * is a faithful formatter even outside the writer). Shortest round-trip digits come from
 * `Number.prototype.toExponential()` with no precision argument, which V8 spells with the same
 * Ryu/Grisu shortest representation as Java's Dragonbound; the digits are then re-spelled with
 * Java's notation rule (`-3 <= decimalExponent < 7` -> plain, else `d.dddE<exp>`).
 */
export function formatJavaDouble(value: number): string {
  if (value === 0) {
    // Java prints the sign of -0.0; `String(-0)` would silently drop it.
    return Object.is(value, -0) ? '-0.0' : '0.0';
  }
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 'Infinity';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Infinity';
  }

  // Fast path for the majority of telemetry samples (gear, lap, ABS, constant speeds):
  // an integer inside Java's plain-notation range needs no digit extraction, and
  // `String(value)` is already the shortest digits Java would print. |v| < 1e7 keeps the
  // scientific-notation switch (`1.0E7`) on the general path.
  if (Number.isInteger(value) && value > -1e7 && value < 1e7) {
    return `${value}.0`;
  }

  const negative = value < 0;
  const digitsAndExponent = (negative ? -value : value).toExponential();
  const exponentAt = digitsAndExponent.indexOf('e');
  const digits = digitsAndExponent.slice(0, exponentAt).replace('.', '');
  const exponent = Number(digitsAndExponent.slice(exponentAt + 1));

  const body =
    exponent >= -3 && exponent < 7
      ? plainNotation(digits, exponent)
      : scientificNotation(digits, exponent);
  return negative ? `-${body}` : body;
}

function plainNotation(digits: string, exponent: number): string {
  if (exponent < 0) {
    // 0.00ddd...: |exponent| - 1 leading zeros after the point (exponent >= -3 here).
    return `0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  const integerDigits = exponent + 1;
  if (digits.length <= integerDigits) {
    // Java always keeps a fraction: 100.0, not 100.
    return `${digits}${'0'.repeat(integerDigits - digits.length)}.0`;
  }
  return `${digits.slice(0, integerDigits)}.${digits.slice(integerDigits)}`;
}

function scientificNotation(digits: string, exponent: number): string {
  const fraction = digits.length > 1 ? digits.slice(1) : '0';
  return `${digits[0]}.${fraction}E${exponent}`;
}

/** Jackson's `JsonStringEncoder.quoteAsString` for a JSON string, including the quotes. */
export function quoteJsonString(text: string): string {
  let quoted = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    switch (code) {
      case 0x08:
        quoted += '\\b';
        break;
      case 0x09:
        quoted += '\\t';
        break;
      case 0x0a:
        quoted += '\\n';
        break;
      case 0x0c:
        quoted += '\\f';
        break;
      case 0x0d:
        quoted += '\\r';
        break;
      case 0x22:
        quoted += '\\"';
        break;
      case 0x5c:
        quoted += '\\\\';
        break;
      default:
        if (code < 0x20) {
          // Jackson writes \u00XX with uppercase hex digits.
          quoted += `\\u00${code.toString(16).toUpperCase().padStart(2, '0')}`;
        } else {
          // Non-ASCII is emitted raw (UTF-8), like Jackson's default; the writer never splits
          // a token across chunks, so a multi-byte name survives the chunk boundary intact.
          quoted += text[i];
        }
        break;
    }
  }
  return `${quoted}"`;
}

/** Fixed-capacity token buffer that turns into sink chunks once it is full. */
class ChunkBuffer {
  private readonly tokens: string[];
  private readonly tokenLimit: number;
  private readonly charLimit: number;
  private count = 0;
  private chars = 0;
  private pendingDrain = false;

  constructor(
    private readonly sink: TelemetrySink,
    chunkTokens: number = DEFAULT_CHUNK_TOKENS,
    chunkChars: number = DEFAULT_CHUNK_CHARS,
  ) {
    this.tokenLimit = Math.max(16, chunkTokens);
    this.charLimit = Math.max(1024, chunkChars);
    // Pre-allocated once; `join` skips the holes, so no per-flush array copy.
    this.tokens = new Array<string>(this.tokenLimit);
  }

  push(token: string): void {
    this.tokens[this.count++] = token;
    this.chars += token.length;
  }

  get full(): boolean {
    return this.count >= this.tokenLimit || this.chars >= this.charLimit;
  }

  /** The destination asked us to slow down; the next drain point will wait for it. */
  get backpressured(): boolean {
    return this.pendingDrain;
  }

  /** Hand the buffered tokens over and, if the destination is full, wait for room. */
  async drain(): Promise<void> {
    this.flush();
    if (!this.pendingDrain) {
      return;
    }
    await this.sink.drain?.();
    this.pendingDrain = false;
    // A dead peer makes every `write` return false, so without this check the writer would
    // keep serializing the rest of the document into nothing.
    if (this.sink.isDestroyed?.() === true) {
      throw new ClientDisconnectedError();
    }
  }

  private flush(): void {
    if (this.count === 0) {
      return;
    }
    if (this.sink.isDestroyed?.() === true) {
      throw new ClientDisconnectedError();
    }
    const payload = this.tokens.slice(0, this.count).join('');
    this.count = 0;
    this.chars = 0;
    if (this.sink.write(payload) === false) {
      this.pendingDrain = true;
    }
  }
}

function toSink(destination: TelemetryDestination): TelemetrySink {
  return typeof destination === 'function' ? { write: destination } : destination;
}

/**
 * An in-memory destination: the whole document ends up in {@link MemorySink.chunks}. Tests use
 * it to `JSON.parse` the result; production code should prefer {@link writableSink}, since this
 * one is exactly the "materialize the response" pattern the writer exists to avoid.
 */
export interface MemorySink extends TelemetrySink {
  readonly chunks: string[];
  /** Number of `drain()` waits the destination was asked for - proves backpressure was honored. */
  drainCalls: number;
  /** When > 0, `write` starts reporting backpressure (and resolves drain on a tick). */
  backpressureAfter: number;
  /** When >= 0, the destination reports itself destroyed after that many writes. */
  destroyAfterWrites: number;
  /** Settable: makes the next `write` throw a client hang-up instead of accepting data. */
  throwOnWrite: Error | null;
  text(): string;
}

export function memorySink(): MemorySink {
  return new InMemorySink();
}

class InMemorySink implements MemorySink {
  readonly chunks: string[] = [];
  drainCalls = 0;
  backpressureAfter = 0;
  /** -1 keeps the sink alive; a non-negative value simulates "peer vanished". */
  destroyAfterWrites = -1;
  throwOnWrite: Error | null = null;

  write(chunk: string): boolean {
    if (this.throwOnWrite !== null) {
      throw this.throwOnWrite;
    }
    if (this.isDestroyed()) {
      throw new ClientDisconnectedError();
    }
    this.chunks.push(chunk);
    return this.backpressureAfter <= 0 || this.chunks.length < this.backpressureAfter;
  }

  drain(): Promise<void> {
    this.drainCalls += 1;
    return new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  isDestroyed(): boolean {
    return this.destroyAfterWrites >= 0 && this.chunks.length >= this.destroyAfterWrites;
  }

  text(): string {
    return this.chunks.join('');
  }
}

/**
 * The destination a route hands to {@link writeTelemetryJson}: `reply.raw` (a Node
 * `ServerResponse`). Encodes every chunk as UTF-8 explicitly (Java's container encoded the
 * body with the response charset) and installs its own `error`/`close` listeners, so a client
 * that hangs up cannot raise an uncaught stream error and cannot leave the writer waiting on a
 * `drain` that will never come.
 */
export function writableSink(target: Writable, options: { logger?: Logger } = {}): TelemetrySink {
  let gone = false;
  let reason: unknown = null;
  const markGone = (error: unknown): void => {
    gone = true;
    reason = error ?? reason;
  };
  target.on('error', (error) => {
    // Never let a dead socket become an uncaught exception; the writer logs it instead.
    markGone(error);
    options.logger?.debug({ err: error }, 'Telemetry response stream errored');
  });
  target.on('close', () => markGone(reason));

  const isGone = (): boolean => gone || target.destroyed;

  return {
    write(chunk: string): boolean {
      if (isGone()) {
        throw new ClientDisconnectedError(reason ?? undefined);
      }
      try {
        return target.write(chunk, 'utf8');
      } catch (error) {
        if (isClientDisconnect(error)) {
          markGone(error);
          throw new ClientDisconnectedError(error);
        }
        throw error;
      }
    },
    drain(): Promise<void> {
      if (isGone() || target.writableEnded || !target.writableNeedDrain) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = (): void => {
          target.off('drain', onDrain);
          target.off('close', onClose);
          target.off('error', onClose);
          resolve();
        };
        const onDrain = (): void => done();
        const onClose = (): void => done();
        target.once('drain', onDrain);
        target.once('close', onClose);
        target.once('error', onClose);
      });
    },
    isDestroyed: isGone,
  };
}
