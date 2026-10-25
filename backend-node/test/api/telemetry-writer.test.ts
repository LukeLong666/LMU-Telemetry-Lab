/**
 * Port of backend-java/src/test/java/com/lmutl/api/TelemetryJsonWriterTest.java plus the
 * Node-specific halves of the writer (chunking, backpressure, client hang-ups).
 *
 * The Java test only asserted "the JSON has these shapes"; here the exact literal is pinned,
 * because the three backends are supposed to be byte-comparable and `Double.toString` spelling
 * ("1.0", "-0.0", "1.0E20") is precisely what a JSON library would silently change.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Channel, type FusedFrame } from '../../src/domain/types.js';
import type { Logger } from '../../src/lib/log.js';
import {
  ClientDisconnectedError,
  formatJavaDouble,
  isClientDisconnect,
  memorySink,
  numberToken,
  quoteJsonString,
  writableSink,
  writeTelemetryJson,
  type MemorySink,
  type TelemetrySink,
} from '../../src/api/telemetry-writer.js';

/** The frame of TelemetryJsonWriterTest.java:20-29 - same channels, values and order. */
function javaTestFrame(): FusedFrame {
  const channels = new Map<string, Channel>([
    ['Time', Channel.scalar('Time', [0.0, 0.1, 0.2])],
    ['Ground Speed', Channel.scalar('Ground Speed', [1.0, Number.NaN, 3.0])],
    [
      'Susp Pos',
      Channel.vector('Susp Pos', [
        [1.0, 2.0, 3.0, 4.0],
        [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      ]),
    ],
  ]);
  return { frequency: 10, time: Float64Array.from([0.0, 0.1, 0.2]), channels };
}

const JAVA_GOLDEN =
  '{"Time":[0.0,0.1,0.2],"Ground Speed":[1.0,null,3.0],' +
  '"Susp Pos":[[1.0,2.0,3.0,4.0],[null,null,null,null]],' +
  '"suspension_baselines":[1.0,2.0,3.0,4.0]}';

function frameOf(...channels: Channel[]): FusedFrame {
  const map = new Map<string, Channel>();
  for (const channel of channels) {
    map.set(channel.name, channel);
  }
  return { frequency: 10, time: map.get('Time')?.data ?? new Float64Array(0), channels: map };
}

/** A 30-channel, `frames`-row grid - the shape of a real stint, with NaN and .25 samples. */
function bigFrame(frames: number, channels: number): FusedFrame {
  const list: Channel[] = [];
  for (let index = 0; index < channels; index++) {
    const data = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      // Mix integral and fractional values so both formatter paths run.
      data[i] = index === 0 ? i : i + 0.25;
    }
    list.push(Channel.scalar(`Ch${index}`, data));
  }
  const wide = new Float64Array(frames * 4);
  for (let i = 0; i < wide.length; i++) {
    wide[i] = i % 7 === 0 ? Number.NaN : i * 0.5;
  }
  list.push(Channel.fromFlat('Susp Pos', 4, wide));
  return frameOf(...list);
}

/** Collects everything written, like the Java test's `ByteArrayOutputStream`. */
async function render(
  frame: FusedFrame,
  baselines: readonly number[],
  options?: Parameters<typeof writeTelemetryJson>[3],
): Promise<{ sink: MemorySink; text: string }> {
  const sink = memorySink();
  await writeTelemetryJson(sink, frame, baselines, options);
  return { sink, text: sink.text() };
}

function disconnected(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

describe('TelemetryJsonWriter literal output', () => {
  it('matches the Java writer character for character', async () => {
    const { sink, text } = await render(javaTestFrame(), [1.0, 2.0, 3.0, 4.0]);
    expect(text).toBe(JAVA_GOLDEN);
    // A small document goes out in a single chunk, and nothing is materialized twice.
    expect(sink.chunks.length).toBe(1);
  });

  it('satisfies the Java test assertions through the parsed document too', async () => {
    const { text } = await render(javaTestFrame(), [1.0, 2.0, 3.0, 4.0]);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json['Time']).toEqual([0.0, 0.1, 0.2]);
    expect(json['Ground Speed']).toEqual([1.0, null, 3.0]);
    expect(json['Susp Pos']).toEqual([
      [1.0, 2.0, 3.0, 4.0],
      [null, null, null, null],
    ]);
    expect(json['suspension_baselines']).toEqual([1.0, 2.0, 3.0, 4.0]);
  });

  it('writes the baselines even when the frame has no channels at all', async () => {
    const empty: FusedFrame = { frequency: 10, time: new Float64Array(0), channels: new Map() };
    const { text } = await render(empty, [0.0, 0.0, 0.0, 0.0]);
    expect(text).toBe('{"suspension_baselines":[0.0,0.0,0.0,0.0]}');
  });

  it('keeps the LinkedHashMap order of the frame as the JSON key order', async () => {
    const frame = frameOf(
      Channel.scalar('Time', [0.0]),
      Channel.scalar('Susp Pos', [1.0]),
      Channel.scalar('Gear', [2.0]),
      Channel.scalar('ABS', [3.0]),
    );
    const { text } = await render(frame, [0.0, 0.0, 0.0, 0.0]);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      'Time',
      'Susp Pos',
      'Gear',
      'ABS',
      'suspension_baselines',
    ]);
  });

  it('nests one sub-array per frame for a wide channel', async () => {
    const frame = frameOf(
      Channel.scalar('Time', [0.0, 1.0]),
      Channel.fromFlat('Tyres', 4, Float64Array.from([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0])),
    );
    const { text } = await render(frame, [9.0]);
    expect(text).toBe(
      '{"Time":[0.0,1.0],"Tyres":[[1.0,2.0,3.0,4.0],[5.0,6.0,7.0,8.0]],"suspension_baselines":[9.0]}',
    );
  });

  it('writes the declared width per frame, not a hard-coded four', async () => {
    const frame = frameOf(Channel.fromFlat('Pair', 2, Float64Array.from([1.0, 2.0, 3.0, 4.0])));
    const { text } = await render(frame, []);
    expect(text).toBe('{"Pair":[[1.0,2.0],[3.0,4.0]],"suspension_baselines":[]}');
  });

  it('emits empty arrays for empty channels', async () => {
    const frame = frameOf(
      Channel.scalar('Empty', new Float64Array(0)),
      Channel.fromFlat('EmptyWide', 4, new Float64Array(0)),
    );
    const { text } = await render(frame, [0.0]);
    expect(text).toBe('{"Empty":[],"EmptyWide":[],"suspension_baselines":[0.0]}');
  });

  it('emits a single frame without a stray separator', async () => {
    const frame = frameOf(Channel.scalar('Gear', [3.0]));
    const { text } = await render(frame, [0.5]);
    expect(text).toBe('{"Gear":[3.0],"suspension_baselines":[0.5]}');
  });

  it('turns a whole NaN channel into nulls', async () => {
    const data = new Float64Array(5).fill(Number.NaN);
    const { text } = await render(frameOf(Channel.scalar('Speed', data)), [Number.NaN]);
    expect(text).toBe('{"Speed":[null,null,null,null,null],"suspension_baselines":[null]}');
  });

  it('turns both infinities into null too, like Double.isInfinite does', async () => {
    const frame = frameOf(
      Channel.scalar('Speed', [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.0]),
    );
    const { text } = await render(frame, [0.0]);
    expect(text).toBe('{"Speed":[null,null,1.0],"suspension_baselines":[0.0]}');
  });

  it('escapes channel names the way Jackson does', async () => {
    const frame = frameOf(Channel.scalar('A "quoted" \\ back\tescape', [1.0]));
    const { text } = await render(frame, [0.0]);
    expect(text).toBe('{"A \\"quoted\\" \\\\ back\\tescape":[1.0],"suspension_baselines":[0.0]}');
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)[0]).toBe(
      'A "quoted" \\ back\tescape',
    );
    expect(quoteJsonString('x\u0001y')).toBe('"x\\u0001y"');
  });

  it('passes non-ASCII names through as raw text, never split across chunks', async () => {
    const frame = frameOf(Channel.scalar('Nürburgring - 24h', [1.0, 2.0]));
    const { text } = await render(frame, [0.0]);
    expect(text).toBe('{"Nürburgring - 24h":[1.0,2.0],"suspension_baselines":[0.0]}');
    expect(JSON.parse(text)).toEqual({ 'Nürburgring - 24h': [1.0, 2.0], suspension_baselines: [0] });
  });

  it('accepts the bare `(chunk) => void` destination form', async () => {
    let collected = '';
    const sizes: number[] = [];
    await writeTelemetryJson(
      (chunk) => {
        collected += chunk;
        sizes.push(chunk.length);
      },
      javaTestFrame(),
      [1.0, 2.0, 3.0, 4.0],
    );
    expect(collected).toBe(JAVA_GOLDEN);
    expect(sizes.length).toBe(1);
  });
});

describe('Double.toString formatting', () => {
  it.each([
    [0, '0.0'],
    [1, '1.0'],
    [3, '3.0'],
    [100, '100.0'],
    [216, '216.0'],
    [1.5, '1.5'],
    [0.1, '0.1'],
    [0.2, '0.2'],
    [3.14159, '3.14159'],
    [0.001, '0.001'],
    [0.01, '0.01'],
    [1234567, '1234567.0'],
    [1_000_000, '1000000.0'],
    [10_000_000, '1.0E7'],
    [12_345_678, '1.2345678E7'],
    [1e15, '1.0E15'],
    [1e20, '1.0E20'],
    [1.2345e20, '1.2345E20'],
    [1e21, '1.0E21'],
    [0.0001, '1.0E-4'],
    [1e-7, '1.0E-7'],
    [-0.5, '-0.5'],
    [-1.0, '-1.0'],
    [-12_345_678, '-1.2345678E7'],
    [1 / 3, '0.3333333333333333'],
    [0.30000000000000004, '0.30000000000000004'],
  ])('formats %p exactly like Java', (value, expected) => {
    expect(formatJavaDouble(value)).toBe(expected);
    // Every literal is valid JSON and round-trips back to the same double.
    expect(JSON.parse(formatJavaDouble(value))).toBe(value);
  });

  it('keeps the sign of negative zero', () => {
    // `===` cannot see the sign, which is why the formatter tests with Object.is.
    expect(-0 === 0).toBe(true);
    expect(Object.is(-0, 0)).toBe(false);
    expect(formatJavaDouble(-0)).toBe('-0.0');
    expect(numberToken(-0)).toBe('-0.0');
  });

  it('spells the non-finite literals Java does, while the writer nulls them out', () => {
    expect(formatJavaDouble(Number.NaN)).toBe('NaN');
    expect(formatJavaDouble(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatJavaDouble(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    expect(numberToken(Number.NaN)).toBe('null');
    expect(numberToken(Number.POSITIVE_INFINITY)).toBe('null');
    expect(numberToken(Number.NEGATIVE_INFINITY)).toBe('null');
  });

  it('writes a -0.0 sample into the payload', async () => {
    const { text } = await render(frameOf(Channel.scalar('Steering Angle', [-0])), [0.0]);
    expect(text).toBe('{"Steering Angle":[-0.0],"suspension_baselines":[0.0]}');
    const parsed = JSON.parse(text) as { 'Steering Angle': number[] };
    expect(Object.is(parsed['Steering Angle'][0], -0)).toBe(true);
  });
});

describe('chunked streaming', () => {
  it('writes a big frame in bounded chunks that reassemble into one valid document', async () => {
    const frames = 20_000;
    const { sink, text } = await render(bigFrame(frames, 30), [1.5, -2.0, 0.0, Number.NaN]);

    expect(sink.chunks.length).toBeGreaterThan(20);
    // No chunk comes anywhere near the size of the document: the response is never materialized.
    const longest = Math.max(...sink.chunks.map((chunk) => chunk.length));
    expect(longest).toBeLessThan(128 * 1024);

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      ...Array.from({ length: 30 }, (_, index) => `Ch${index}`),
      'Susp Pos',
      'suspension_baselines',
    ]);
    const ch0 = parsed['Ch0'] as number[];
    const ch1 = parsed['Ch1'] as number[];
    expect(ch0.length).toBe(frames);
    expect(ch0[0]).toBe(0);
    expect(ch0[frames - 1]).toBe(frames - 1);
    expect(ch1[10]).toBe(10.25);
    expect(parsed['suspension_baselines']).toEqual([1.5, -2.0, 0.0, null]);

    const wide = parsed['Susp Pos'] as (number | null)[][];
    expect(wide.length).toBe(frames);
    expect(wide[0]).toEqual([null, 0.5, 1.0, 1.5]);
    expect(wide[frames - 1][1]).toBe((frames - 1) * 4 * 0.5 + 0.5);
    // The NaN samples are null in the payload but still numbers where they were sampled.
    expect(wide.every((row) => row.length === 4)).toBe(true);
  });

  it('honours the configured chunk size knobs', async () => {
    const { sink } = await render(bigFrame(5_000, 2), [0.0], { chunkTokens: 64, chunkChars: 2048 });
    expect(sink.chunks.length).toBeGreaterThan(200);
    const longest = Math.max(...sink.chunks.map((chunk) => chunk.length));
    // The 64-token limit bites long before the 2048-character one for these token widths.
    expect(longest).toBeLessThanOrEqual(64 * 24 + 24);
    expect(JSON.parse(sink.text())).toBeTruthy();
  });

  it('keeps every chunk when the destination reports backpressure', async () => {
    const frame = bigFrame(10_000, 4);
    const sink = memorySink();
    sink.backpressureAfter = 1;
    await writeTelemetryJson(sink, frame, [0.0]);

    expect(sink.drainCalls).toBeGreaterThan(0);
    expect(sink.text()).toBe((await render(frame, [0.0])).text);
    expect(JSON.parse(sink.text())).toBeTruthy();
  });
});

describe('backpressure against a real stream', () => {
  it('waits for drain instead of queueing the whole response', async () => {
    const received: string[] = [];
    let writeCalls = 0;
    let maxQueuedBytes = 0;
    const collector = new Writable({
      highWaterMark: 4096,
      write(chunk, _encoding, callback) {
        writeCalls += 1;
        maxQueuedBytes = Math.max(maxQueuedBytes, collector.writableLength);
        received.push(String(chunk));
        // Slow consumer: this is what makes write() return false.
        setImmediate(callback);
      },
    });

    const base = writableSink(collector);
    let drains = 0;
    const counting: TelemetrySink = {
      write: (chunk) => base.write(chunk),
      drain: () => {
        drains += 1;
        return base.drain?.();
      },
      isDestroyed: () => base.isDestroyed?.() === true,
    };

    await writeTelemetryJson(counting, bigFrame(20_000, 10), [1.0, 2.0, 3.0, 4.0]);

    expect(drains).toBeGreaterThan(0);
    expect(writeCalls).toBeGreaterThan(1);
    // At most one extra chunk sits in the stream queue: the writer respects the socket.
    expect(maxQueuedBytes).toBeLessThan(256 * 1024);
    const parsed = JSON.parse(received.join('')) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBe(12);
    expect((parsed['Ch0'] as number[]).length).toBe(20_000);
  });

  it('writes UTF-8 bytes for a multi-byte channel name through a real stream', async () => {
    const received: Buffer[] = [];
    const collector = new Writable({
      write(chunk, _encoding, callback) {
        received.push(Buffer.from(chunk as string, 'utf8'));
        callback();
      },
    });
    await writeTelemetryJson(
      writableSink(collector),
      frameOf(Channel.scalar('São Paulo - ¹', [1.0])),
      [0.0],
    );
    expect(Buffer.concat(received).toString('utf8')).toBe(
      '{"São Paulo - ¹":[1.0],"suspension_baselines":[0.0]}',
    );
  });
});

describe('client hang-ups', () => {
  it('swallows a destination that throws ERR_STREAM_DESTROYED', async () => {
    const sink = memorySink();
    sink.throwOnWrite = disconnected('ERR_STREAM_DESTROYED');
    await expect(writeTelemetryJson(sink, javaTestFrame(), [0.0])).resolves.toBeUndefined();
    expect(sink.chunks.length).toBe(0);
  });

  it('swallows an EPIPE that arrives mid-document', async () => {
    const sink = memorySink();
    let writes = 0;
    sink.write = (chunk: string): boolean => {
      writes += 1;
      if (writes === 3) {
        throw disconnected('EPIPE');
      }
      sink.chunks.push(chunk);
      return true;
    };
    await expect(writeTelemetryJson(sink, bigFrame(5_000, 2), [0.0])).resolves.toBeUndefined();
    expect(writes).toBe(3);
    expect(sink.chunks.length).toBe(2);
    expect(sink.text().startsWith('{"Ch0":[')).toBe(true);
  });

  it('stops early when the destination reports itself destroyed', async () => {
    const sink = memorySink();
    sink.destroyAfterWrites = 2;
    await expect(writeTelemetryJson(sink, bigFrame(20_000, 10), [0.0])).resolves.toBeUndefined();
    expect(sink.chunks.length).toBe(2);
    expect(() => JSON.parse(sink.text())).toThrow();
  });

  it('does not spin or crash on an already-destroyed stream', async () => {
    const collector = new Writable({
      highWaterMark: 64,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    collector.destroy();
    // writableSink subscribes to 'error' itself, so a dead socket cannot become uncaught.
    await expect(
      writeTelemetryJson(writableSink(collector), javaTestFrame(), [0.0]),
    ).resolves.toBeUndefined();
  });

  it('downgrades the hang-up to a log line', async () => {
    const messages: string[] = [];
    const logger = {
      debug: (binding: unknown, message?: unknown) => {
        messages.push(String(typeof binding === 'string' ? binding : message));
      },
    } as unknown as Logger;
    const sink = memorySink();
    sink.destroyAfterWrites = 0;
    await writeTelemetryJson(sink, javaTestFrame(), [0.0], { logger });
    expect(sink.chunks.length).toBe(0);
    expect(messages).toEqual(['Telemetry response aborted by the client']);
  });

  it('rethrows a destination failure that is not a hang-up', async () => {
    const sink = memorySink();
    sink.throwOnWrite = new Error('disk on fire');
    await expect(writeTelemetryJson(sink, javaTestFrame(), [0.0])).rejects.toThrow('disk on fire');
  });

  it('classifies disconnects', () => {
    expect(isClientDisconnect(new ClientDisconnectedError())).toBe(true);
    expect(isClientDisconnect(disconnected('EPIPE'))).toBe(true);
    expect(isClientDisconnect(disconnected('ECONNRESET'))).toBe(true);
    expect(isClientDisconnect(disconnected('ERR_STREAM_WRITE_AFTER_END'))).toBe(true);
    expect(isClientDisconnect(new Error('x'))).toBe(false);
    expect(isClientDisconnect('EPIPE')).toBe(false);
    expect(isClientDisconnect(null)).toBe(false);
  });
});
